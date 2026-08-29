import type {Message} from "../llm/types.js";

// history 只存真实对话（user input + assistant + tool），不存 userContext。
// 每次 callLLM 前把 userContext 作为独立的临时 user message 插到 system 后：
//   [system, userContext, firstUser, assistant/tool/后续 user...]
// 这样 prompt-log 里真实用户输入不会和 <system-reminder> 混在同一条 message 里；
// userContext 仍然处在稳定前缀位置，有利于 GLM 自动缓存命中。
export function buildInvokeMessages(
    history: Message[],
    userContextBlocks: string[]
): Message[] {
    const system = history[0];
    if (!system || system.role !== "system") {
        return history;
    }

    if (history.length <= 1 || userContextBlocks.length === 0) {
        return history;
    }

    const userContextMessage: Message = {
        role: "user",
        content: userContextBlocks.join("\n\n"),
    };

    return [system, userContextMessage, ...history.slice(1)];
}
