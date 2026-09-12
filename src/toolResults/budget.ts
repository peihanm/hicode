import {contentText, replaceContentText} from "../images/content.js";
import type {Message} from "../llm/types.js";
import {buildPersistedToolResultMessage, buildPersistFailureMessage, createPreview,} from "./format.js";
import {ToolResultStore} from "./store.js";
import {
    DEFAULT_DISPLAY_CHARS,
    DEFAULT_MAX_RESULT_CHARS,
    MAX_TOOL_RESULTS_PER_BATCH_CHARS,
    type PersistedToolResult,
    type ToolExecutionResult,
    type ToolOutcome,
    type ToolOutput,
} from "./types.js";

export async function processToolOutput(input: {
    output: ToolOutput;
    outcome?: ToolOutcome;
    toolName: string;
    toolCallId: string;
    maxResultSizeChars?: number;
    store: ToolResultStore;
}): Promise<ToolExecutionResult> {
    const original = typeof input.output === "string"
        ? {content: input.output}
        : input.output;
    const normalized = {...original, content: contentText(original.content)};
    const outcome = normalized.outcome ?? input.outcome ?? "ok";
    const uiData = outcome === "ok" ? normalized.uiData : undefined;
    const displayContent = normalized.displayContent ?? normalized.content;
    if (normalized.persisted) {
        const reference = buildPersistedToolResultMessage(normalized.persisted);
        return {
            modelContent: replaceContentText(original.content, normalized.content.trim() ? `${normalized.content}\n\n${reference}` : reference),
            displayContent: createPreview(displayContent, DEFAULT_DISPLAY_CHARS),
            outcome,
            persisted: normalized.persisted,
            ...(uiData ? {uiData} : {}),
        };
    }
    const content = normalized.content.trim().length === 0
        ? `(${input.toolName} executed with no output)`
        : normalized.content;
    const threshold = input.maxResultSizeChars ?? DEFAULT_MAX_RESULT_CHARS;
    if (!Number.isFinite(threshold) || content.length <= threshold) {
        return {
            modelContent: typeof original.content === "string" ? content : original.content,
            displayContent: createPreview(displayContent, DEFAULT_DISPLAY_CHARS),
            outcome,
            ...(uiData ? {uiData} : {}),
        };
    }
    const preview = createPreview(content, input.store.previewChars);
    try {
        const persisted = await input.store.persistText({
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            content,
        });
        return {
            modelContent: replaceContentText(original.content, buildPersistedToolResultMessage(persisted)),
            displayContent: preview,
            outcome,
            persisted,
            ...(uiData ? {uiData} : {}),
        };
    } catch (error) {
        return {
            modelContent: replaceContentText(original.content, buildPersistFailureMessage(input.toolName, preview, error)),
            displayContent: `${preview}\n\n(Failed to save full result)`,
            outcome,
            ...(uiData ? {uiData} : {}),
        };
    }
}

export interface BatchToolResultEntry {
    messageIndex: number;
    toolCallId: string;
    toolName: string;
    persisted?: PersistedToolResult;
}

export async function applyBatchToolResultBudget(input: {
    history: Message[];
    entries: BatchToolResultEntry[];
    store: ToolResultStore;
    maxChars?: number;
}): Promise<Array<{ toolCallId: string; persisted: PersistedToolResult }>> {
    const maxChars = input.maxChars ?? MAX_TOOL_RESULTS_PER_BATCH_CHARS;
    const candidates = input.entries.flatMap((entry) => {
        const message = input.history[entry.messageIndex];
        if (entry.persisted || message?.role !== "tool") return [];
        return [{...entry, content: contentText(message.content)}];
    });
    let total = input.entries.reduce((sum, entry) => {
        const message = input.history[entry.messageIndex];
        return sum + (message?.role === "tool" ? contentText(message.content).length : 0);
    }, 0);
    if (total <= maxChars) return [];

    const replacements: Array<{ toolCallId: string; persisted: PersistedToolResult }> = [];
    for (const candidate of [...candidates].sort((a, b) => b.content.length - a.content.length)) {
        if (total <= maxChars) break;
        // A persisted reference includes a preview and metadata. Very small blocks
        // would make the prompt larger rather than smaller, so leave them inline.
        if (candidate.content.length <= input.store.previewChars + 600) continue;
        const message = input.history[candidate.messageIndex];
        if (message?.role !== "tool") continue;
        try {
            const persisted = await input.store.persistText({
                toolCallId: candidate.toolCallId,
                toolName: candidate.toolName,
                content: candidate.content,
            });
            const replacement = buildPersistedToolResultMessage(persisted);
            if (replacement.length >= contentText(message.content).length) {
                await input.store.removeArtifact(persisted.resultId);
                continue;
            }
            total += replacement.length - contentText(message.content).length;
            message.content = replaceContentText(message.content, replacement);
            replacements.push({toolCallId: candidate.toolCallId, persisted});
        } catch (error) {
            const preview = createPreview(candidate.content, input.store.previewChars);
            const replacement = buildPersistFailureMessage(candidate.toolName, preview, error);
            total += replacement.length - contentText(message.content).length;
            message.content = replaceContentText(message.content, replacement);
        }
    }
    return replacements;
}
