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
    const start = findCompactTailStart([system, ...labelled], remaining,
        new Set([...mandatory].map(index => index + 1))) - 1;
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

/** Tool groups are admitted atomically, before spending the tail budget. */
function findCompactTailStart(history: Message[], maxTokens: number, reserved: ReadonlySet<number>): number {
    let start = history.length;
    let tokens = 0;
    while (start > 1 && maxTokens >= 0) {
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
        const cost = group.reduce((sum, message, index) => sum + (reserved.has(groupStart + index) ? 0 : estimateMessageTokens(message)), 0);
        if (tokens + cost > maxTokens) break;
        tokens += cost;
        start = groupStart;
    }
    return start;
}

const RECENT_HISTORY_TOKEN_BUDGET = 20_000;

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
    const retainedHistory = retainImageDeliveryBoundary(history);
    const latestUser = latestUserIndex > 0 ? retainedHistory[latestUserIndex] : undefined;
    const latestTokens = latestUser ? estimateMessageTokens(latestUser) : 0;
    // Reserve the latest request once, whether it lands inside or outside the contiguous tail.
    const available = Math.min(target, actualPreTokens) - fixedTokens - summaryTokens - latestTokens - 1;
    if (available < 0) return undefined;
    const start = findCompactTailStart(retainedHistory, Math.min(RECENT_HISTORY_TOKEN_BUDGET, available),
        new Set(latestUser ? [latestUserIndex] : []));
    return [system, summaryMessage,
        ...(latestUser && latestUserIndex < start ? [latestUser] : []),
        ...retainedHistory.slice(start)];
}
