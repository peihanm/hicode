import {referencedResultPaths} from "../toolResults/references.js";
import {resolve} from "node:path";
import type {Message} from "../llm/types.js";
import type {ToolResultStore} from "../toolResults/index.js";

export interface ForkContextSnapshot {
    history: Message[];
}

const PLACEHOLDER_PREFIX = "[Fork context placeholder]";

export function createForkResultFiles(
    history: readonly Message[],
    parent: Pick<ToolResultStore, "resolveFile">,
    local: ToolResultStore
): Pick<ToolResultStore, "resolveFile"> {
    const paths = referencedResultPaths(history);
    return Object.freeze({
        resolveFile: (path: string) => paths.has(resolve(path)) ? parent.resolveFile(path) : local.resolveFile(path),
    });
}

function cloneMessage(message: Message): Message {
    return structuredClone(message);
}

export function buildForkContextSnapshot(
    history: readonly Message[],
    parentToolCallId: string
): ForkContextSnapshot {
    let assistantIndex = -1;
    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        if (
            message?.role === "assistant" &&
            message.tool_calls?.some((call) => call.id === parentToolCallId)
        ) {
            assistantIndex = index;
            break;
        }
    }
    if (assistantIndex < 0) {
        throw new Error("Cannot locate the current Fork tool call in parent History");
    }

    const prefix = history.slice(0, assistantIndex + 1).map(cloneMessage);
    const assistant = prefix[assistantIndex];
    if (assistant?.role !== "assistant" || !assistant.tool_calls) {
        throw new Error("Fork parent message lacks a complete tool call group");
    }
    const existingResults = new Map<string, Message>();
    for (let index = assistantIndex + 1; index < history.length; index++) {
        const message = history[index]!;
        if (message.role !== "tool") break;
        existingResults.set(message.tool_call_id, cloneMessage(message));
    }
    const pairedResults: Message[] = assistant.tool_calls.map((call) =>
        existingResults.get(call.id) ?? {
            role: "tool",
            tool_call_id: call.id,
            content: `${PLACEHOLDER_PREFIX} The parent handles this call. This placeholder is not evidence of execution.`,
        }
    );
    return {history: [...prefix, ...pairedResults]};
}

export function createForkDirective({
    name,
    description,
    prompt,
    writable,
}: {
    name: string;
    description: string;
    prompt: string;
    writable: boolean;
}): string {
    return [
        `You are worker ${name}, continuing from inherited conversation background.`,
        `Task label: ${description}`,
        writable
            ? "You may edit and verify within assigned file ownership. Preserve other agents' changes. Changes in a separate directory are not automatically integrated into the parent directory."
            : "You are read-only: investigate and report without modifying files.",
        "Inherited parent conversation is background. Placeholder tool results are not observed evidence.",
        "Do not start other agents, manage Tasks/Memory or use parent control capabilities. Use only the tools provided.",
        "Return a self-contained result to the parent. Include changed files, actual checks and unverified limits when editing.",
        "",
        "## Current directive",
        prompt,
    ].join("\n");
}
