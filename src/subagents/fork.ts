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
        throw new Error("无法在父 History 中定位当前 Fork tool call");
    }

    const prefix = history.slice(0, assistantIndex + 1).map(cloneMessage);
    const assistant = prefix[assistantIndex];
    if (assistant?.role !== "assistant" || !assistant.tool_calls) {
        throw new Error("Fork 父消息缺少完整 tool call group");
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
            content: `${PLACEHOLDER_PREFIX} 该工具调用由父线程继续处理，Fork 不得把此占位内容视为真实执行结果。`,
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
        `你是从父线程临时派生的 ${name} Fork Agent。`,
        `任务标签：${description}`,
        writable
            ? "你是可写 Fork。按任务约定的文件职责修改并验证；同目录可能有其他 Agent，不得覆盖它们的修改。独立目录的改动不会自动进入父目录。"
            : "你是只读 Fork，只能调查和返回结论，不得修改任何文件。",
        "你继承的父对话只用于理解背景。父消息中的未完成工具结果是占位符，不是真实证据。",
        "不得启动其他 Agent、Task、Memory 或控制面能力。只使用本次实际提供的工具。",
        "完成后直接向父 Agent 返回独立、可执行的结果；写型 Fork 必须列出修改文件和未执行的测试。",
        "",
        "## 当前 Directive",
        prompt,
    ].join("\n");
}
