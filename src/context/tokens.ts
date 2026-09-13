import {contentText, imageReferences, IMAGE_ESTIMATED_TOKENS} from "../images/content.js";
import type {Message, OpenAITool} from "../llm/types.js";

// Use chars/2, more conservative than chars/4 for English-heavy input.
// CJK input is still supported; chars/4 would underestimate it and delay Auto-Compact.
const DEFAULT_ESTIMATION_CHARS_PER_TOKEN = 2;

// Coarse chars/N estimate; bytesPerToken retains Claude Code's parameter naming.
function roughTokenCountEstimation(
    content: string,
    bytesPerToken: number = DEFAULT_ESTIMATION_CHARS_PER_TOKEN
): number {
    return Math.round(content.length / bytesPerToken);
}

// Estimate tokens per message, including content and tool_calls.
export function estimateMessageTokens(msg: Message): number {
    let total = 0;

    // content may be string, null or undefined.
    if (typeof msg.content === "string") {
        total += roughTokenCountEstimation(msg.content);
    }

    if (Array.isArray(msg.content)) total += roughTokenCountEstimation(contentText(msg.content)) + imageReferences(msg.content).length * IMAGE_ESTIMATED_TOKENS;

    // Include assistant tool_calls using their JSON representation.
    if (msg.role === "assistant" && msg.tool_calls) {
        total += roughTokenCountEstimation(JSON.stringify(msg.tool_calls));
    }
    if (msg.role === "assistant" && msg.reasoning?.content) {
        total += roughTokenCountEstimation(msg.reasoning?.content);
    }

    return total;
}

// Estimate tool-schema tokens.
// The request tools field consumes tokens too, often more than messages, due to descriptions and parameters.
// Claude Code's tokenCountWithEstimation does not count tools separately, but splitSysPromptPrefix
// includes them in cache scope. This implementation counts them explicitly.
function estimateToolsTokens(tools: OpenAITool[]): number {
    return roughTokenCountEstimation(JSON.stringify(tools));
}

// Total estimate: messages plus tool schemas.
// Used for compaction and warning thresholds.
// Tool descriptions and schemas consume context and must be counted.
export function tokenCountWithEstimation(
    messages: Message[],
    tools?: OpenAITool[]
): number {
    const msgTokens = messages.reduce(
        (sum, m) => sum + estimateMessageTokens(m),
        0
    );
    const toolTokens = tools ? estimateToolsTokens(tools) : 0;
    return msgTokens + toolTokens;
}
