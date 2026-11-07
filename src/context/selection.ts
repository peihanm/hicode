import {retainImageDeliveryBoundary} from "../images/request.js";
import {contentText} from "../images/content.js";
import type {Message} from "../llm/types.js";
import {estimateMessageTokens, tokenCountWithEstimation} from "./tokens.js";
import {labelHandoffSources, type HandoffSources} from "./handoff.js";
import {buildInvokeMessages} from "../prompt/messages.js";

export function selectCompactInput(input: {
    system: Extract<Message, {role: "system"}>;
    conversation: Message[];
    prompt: string;
    budget: number;
    sources?: HandoffSources;
}): {messages: Message[]; coverage: string} {
    const {system, conversation, prompt, budget, sources} = input;
    const projected = buildInvokeMessages(conversation, []);
    const labelled = sources ? labelHandoffSources(projected, sources) : projected.map(message => {
        if (message.role !== "assistant") return {...message, content: contentText(message.content)};
        const {reasoning: _reasoning, ...visible} = message;
        return visible;
    });
    const full: Message[] = [system, ...labelled, {role: "user", origin: "runtime" as const, content: prompt}];
    if (tokenCountWithEstimation(full) <= budget) return {messages: full, coverage: ""};
    if (!sources) throw new Error("compact prompt too long: estimated input exceeds budget; internal Agent has no source archive. Original history was preserved.");

    const mandatory = new Set<number>();
    // The prior handoff is part of History, not a second mutable state object.
    if (conversation[0]?.role === "user" && conversation[0].origin === "compaction") mandatory.add(0);
    const latest = conversation.findLastIndex(message => message.role === "user" && (message.origin === "user" || message.origin === "assignment"));
    if (latest >= 0) mandatory.add(latest);
    const fixed = tokenCountWithEstimation([system, {role: "user", origin: "runtime" as const, content: prompt}]) +
        [...mandatory].reduce((sum, index) => sum + estimateMessageTokens(labelled[index]!), 0);
    // At most three omitted ranges: a suffix plus the two required messages above.
    const remaining = budget - fixed - 512;
    if (remaining <= 0) throw new Error("Handoff input budget cannot fit the current request, prior handoff and fixed instructions. Original history was preserved.");
    const start = findCompactTailStart([system, ...labelled], {
        minTokens: Number.MAX_SAFE_INTEGER, minTextMessages: Number.MAX_SAFE_INTEGER, maxTokens: remaining,
    }) - 1;
    const selected = new Set([...mandatory, ...Array.from({length: labelled.length - start}, (_, index) => start + index)]);
    const omitted: string[] = [];
    for (let index = 0; index < labelled.length;) {
        if (selected.has(index)) {index++; continue;}
        const begin = index;
        while (index < labelled.length && !selected.has(index)) index++;
        omitted.push(`[[${sources.current.id}/${begin + 1}]]..[[${sources.current.id}/${index}]]`);
    }
    const coverage = `Handoff coverage limit: original ranges omitted from this summarization request: ${omitted.join(", ")}. They remain in the source index. This handoff does not cover the entire conversation; consult sources for exact details.`;
    const messages: Message[] = [system, ...labelled.filter((_, index) => selected.has(index)),
        {role: "user", origin: "runtime" as const, content: `${prompt}\n\n${coverage}`}];
    if (tokenCountWithEstimation(messages) > budget) throw new Error("Handoff input and coverage notice exceed the budget. Original history was preserved.");
    return {messages, coverage};
}

interface CompactTailOptions {
    minTokens: number;
    minTextMessages: number;
    maxTokens: number;
}

/** Tool groups are admitted atomically, before spending the tail budget. */
function findCompactTailStart(history: Message[], options: CompactTailOptions): number {
    let start = history.length;
    let tokens = 0;
    let textMessages = 0;
    while (start > 1 && options.maxTokens > 0) {
        let groupStart = start - 1;
        if (history[groupStart]?.role === "tool") {
            while (groupStart > 1 && history[groupStart]?.role === "tool") groupStart--;
            const assistant = history[groupStart];
            if (assistant?.role !== "assistant" || !assistant.tool_calls) throw new Error("Compact tail contains an unpaired tool result");
            const ids = new Set(assistant.tool_calls.map(call => call.id));
            for (let index = groupStart + 1; index < start; index++) {
                const result = history[index]!;
                if (result.role !== "tool" || !ids.delete(result.tool_call_id)) throw new Error("Compact tail has an invalid tool-result pairing");
            }
            if (ids.size) throw new Error("Compact tail is missing a tool result");
        }
        const first = history[groupStart];
        if (groupStart === start - 1 && first?.role === "assistant" && first.tool_calls?.length) {
            throw new Error("Compact tail is missing a tool result");
        }
        const group = history.slice(groupStart, start);
        const cost = group.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        if (tokens + cost > options.maxTokens) break;
        tokens += cost;
        textMessages += group.filter(message => (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string" && message.content.trim().length > 0).length;
        start = groupStart;
        if (tokens >= options.minTokens && textMessages >= options.minTextMessages) break;
    }
    return start;
}

/** Retain recent user wording and complete question/answer groups without duplicating the tail. */
function selectOriginalAnchors(history: Message[], latestUserIndex: number): number[] {
    // Keep a bounded recent sequence without classifying text as permission or intent.
    const anchors: number[] = [];
    let anchorTokens = 0;
    for (let index = history.length - 1; index > 0 && anchors.length < 3; index--) {
        const message = history[index]!;
        if (message.role !== "user" || (message.origin !== "user" && message.origin !== "assignment")) continue;
        const cost = estimateMessageTokens(message);
        if (index === latestUserIndex || anchorTokens + cost <= 2000) {
            anchors.unshift(index);
            if (index !== latestUserIndex) anchorTokens += cost;
        }
    }
    let answers = 0;
    for (let index = history.length - 1; index > 0 && answers < 2; index--) {
        const message = history[index]!;
        if (message.role !== "assistant" || !message.tool_calls?.some(call => call.function.name === "ask_user")) continue;
        const end = index + message.tool_calls.length + 1;
        const results = history.slice(index + 1, end);
        const ids = new Set(message.tool_calls.map(call => call.id));
        if (results.length !== ids.size || results.some(result => result.role !== "tool" || !ids.delete(result.tool_call_id)) || ids.size) continue;
        const cost = history.slice(index, end).reduce((sum, entry) => sum + estimateMessageTokens(entry), 0);
        if (anchorTokens + cost > 2000) continue;
        anchorTokens += cost;
        answers++;
        for (let entry = index; entry < end; entry++) anchors.push(entry);
    }
    anchors.sort((a, b) => a - b);
    return anchors;
}

export function selectCompactedHistory(input: {
    history: Message[];
    system: Extract<Message, {role: "system"}>;
    summaryMessage: Message;
    latestUserIndex: number;
    fixedTokens: number;
    summaryTokens: number;
    target: number;
    actualPreTokens: number;
}): Message[] | undefined {
    const {history, system, summaryMessage, latestUserIndex, fixedTokens, summaryTokens, target, actualPreTokens} = input;
    const latestUser = latestUserIndex > 0 ? history[latestUserIndex] : undefined;
    const retainedHistory = retainImageDeliveryBoundary(history);
    const anchors = selectOriginalAnchors(history, latestUserIndex);
    const tailBudget = Math.max(0, target - fixedTokens - summaryTokens);
    const tailStart = findCompactTailStart(history, {
        minTokens: Math.min(10_000, Math.floor(tailBudget / 4)),
        minTextMessages: 5,
        maxTokens: tailBudget,
    });
    let tailTokens = history.slice(tailStart).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    for (let start = tailStart; start <= history.length; start++) {
        if (start > tailStart) tailTokens -= estimateMessageTokens(history[start - 1]!);
        if (history[start]?.role === "tool") continue;
        const preserved = anchors.filter(index => index < start);
        if (latestUser && latestUserIndex < start && !preserved.includes(latestUserIndex)) preserved.push(latestUserIndex);
        const preservedTokens = preserved.reduce((sum, index) => sum + estimateMessageTokens(history[index]!), 0);
        const candidateTokens = fixedTokens + summaryTokens + tailTokens + preservedTokens;
        if (candidateTokens >= target || candidateTokens >= actualPreTokens) continue;
        return [system, summaryMessage, ...preserved.map(index => retainedHistory[index]!), ...retainedHistory.slice(start)];
    }
    return undefined;
}
