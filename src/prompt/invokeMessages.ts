import type {Message} from "../llm/types.js";

// History stores real user/assistant/tool conversation, not userContext.
// Before each callLLM, insert userContext as a transient user message after system:
// [system, userContext, firstUser, assistant/tool/later user...]
// This keeps real user input separate from system-reminder messages in prompt logs,
// while userContext remains in the stable prefix for provider caching.
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
        role: "user", origin: "runtime" as const,
        content: userContextBlocks.join("\n\n"),
    };

    return [system, userContextMessage, ...history.slice(1)];
}
