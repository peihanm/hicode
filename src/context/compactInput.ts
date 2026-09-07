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
        if (message.role !== "assistant") return message;
        const {reasoning_content: _reasoning, ...visible} = message;
        return visible;
    });
    const full: Message[] = [system, ...labelled, {role: "user", content: prompt}];
    if (tokenCountWithEstimation(full) <= budget) return {messages: full, coverage: ""};
    if (!sources) throw new Error("compact prompt too long: 估算已超过输入预算；内部 Agent 无来源档案，原历史已保留");

    const mandatory = new Set<number>();
    // The prior handoff is part of History, not a second mutable state object.
    if (conversation[0]?.role === "user" && conversation[0].content.startsWith("<system-reminder>\n本会话已压缩。")) mandatory.add(0);
    const latest = conversation.findLastIndex(message => message.role === "user");
    if (latest >= 0) mandatory.add(latest);
    const fixed = tokenCountWithEstimation([system, {role: "user", content: prompt}]) +
        [...mandatory].reduce((sum, index) => sum + estimateMessageTokens(labelled[index]!), 0);
    // At most three omitted ranges: a suffix plus the two required messages above.
    const remaining = budget - fixed - 512;
    if (remaining <= 0) throw new Error("交接输入预算无法容纳当前请求、上一份交接与固定指令，原历史已保留");
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
    const coverage = `交接覆盖限制：本次未提交给摘要模型的原文范围为 ${omitted.join(", ")}。这些内容仍在来源索引中；本交接不代表已总结全部会话，精确细节需回查。`;
    const messages: Message[] = [system, ...labelled.filter((_, index) => selected.has(index)),
        {role: "user", content: `${prompt}\n\n${coverage}`}];
    if (tokenCountWithEstimation(messages) > budget) throw new Error("交接输入及覆盖说明超过预算，原历史已保留");
    return {messages, coverage};
}
