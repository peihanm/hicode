import type {Message} from "../llm/types.js";
import {estimateMessageTokens} from "./tokens.js";

interface CompactTailOptions {
    minTokens: number;
    minTextMessages: number;
    maxTokens: number;
}

function hasTextContent(message: Message): boolean {
    if (message.role === "user") {
        return message.content.trim().length > 0;
    }
    if (message.role === "assistant") {
        return typeof message.content === "string" && message.content.trim().length > 0;
    }
    return false;
}

function getToolResultIds(message: Message): string[] {
    return message.role === "tool" ? [message.tool_call_id] : [];
}

function getToolUseIds(message: Message): string[] {
    return message.role === "assistant" && message.tool_calls
        ? message.tool_calls.map((toolCall) => toolCall.id)
        : [];
}

function adjustTailStartForToolPairs(
    history: Message[],
    start: number
): number {
    let adjustedStart = start;

    while (adjustedStart > 1) {
        const resultIds = new Set<string>();
        const toolUseIds = new Set<string>();

        for (let i = adjustedStart; i < history.length; i++) {
            for (const id of getToolResultIds(history[i]!)) resultIds.add(id);
            for (const id of getToolUseIds(history[i]!)) toolUseIds.add(id);
        }

        const missing = [...resultIds].filter((id) => !toolUseIds.has(id));
        if (missing.length === 0) return adjustedStart;

        const missingSet = new Set(missing);
        let foundStart = adjustedStart;
        for (let i = adjustedStart - 1; i >= 1 && missingSet.size > 0; i--) {
            const ids = getToolUseIds(history[i]!);
            if (ids.some((id) => missingSet.has(id))) {
                foundStart = i;
                for (const id of ids) missingSet.delete(id);
            }
        }

        if (foundStart === adjustedStart) return adjustedStart;
        adjustedStart = foundStart;
    }

    return adjustedStart;
}

function createCompactTailFinder(
    estimateTokens: (message: Message) => number
) {
    return function findCompactTailStart(
        history: Message[],
        {minTokens, minTextMessages, maxTokens}: CompactTailOptions
    ): number {
        if (history.length <= 1 || maxTokens <= 0) return history.length;

        let start = history.length;
        let totalTokens = 0;
        let textMessages = 0;

        for (let i = history.length - 1; i >= 1; i--) {
            const message = history[i]!;
            totalTokens += estimateTokens(message);
            if (hasTextContent(message)) textMessages += 1;
            start = i;

            if (totalTokens >= maxTokens) break;
            if (totalTokens >= minTokens && textMessages >= minTextMessages) break;
        }

        return adjustTailStartForToolPairs(history, start);
    };
}

export const findCompactTailStart =
    createCompactTailFinder(estimateMessageTokens);
