import type {Message} from "../llm/types.js";
import {estimateMessageTokens} from "./tokens.js";

interface CompactTailOptions {
    minTokens: number;
    minTextMessages: number;
    maxTokens: number;
}

/** Tool groups are admitted atomically, before spending the tail budget. */
export function findCompactTailStart(history: Message[], options: CompactTailOptions): number {
    let start = history.length;
    let tokens = 0;
    let textMessages = 0;
    while (start > 1 && options.maxTokens > 0) {
        let groupStart = start - 1;
        if (history[groupStart]?.role === "tool") {
            while (groupStart > 1 && history[groupStart]?.role === "tool") groupStart--;
            const assistant = history[groupStart];
            if (assistant?.role !== "assistant" || !assistant.tool_calls) throw new Error("Compact tail 包含未配对的 tool result");
            const ids = new Set(assistant.tool_calls.map(call => call.id));
            for (let index = groupStart + 1; index < start; index++) {
                const result = history[index]!;
                if (result.role !== "tool" || !ids.delete(result.tool_call_id)) throw new Error("Compact tail 的 tool result 配对非法");
            }
            if (ids.size) throw new Error("Compact tail 缺少 tool result");
        }
        const first = history[groupStart];
        if (groupStart === start - 1 && first?.role === "assistant" && first.tool_calls?.length) {
            throw new Error("Compact tail 缺少 tool result");
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
