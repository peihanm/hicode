import {contentText} from "../images/content.js";
import type {Message} from "../llm/types.js";
import {findCompactTailStart} from "./compactTail.js";
import {estimateMessageTokens, tokenCountWithEstimation} from "./tokens.js";
import {labelHandoffSources, type HandoffSources} from "./handoff.js";

export function selectCompactInput(input: {
    system: Extract<Message, {role: "system"}>;
    conversation: Message[];
    prompt: string;
    budget: number;
    sources?: HandoffSources;
}): {messages: Message[]; coverage: string} {
    const {system, conversation, prompt, budget, sources} = input;
    const labelled = sources ? labelHandoffSources(conversation, sources) : conversation.map(message => {
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
