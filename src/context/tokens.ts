import {contentText, imageReferences, IMAGE_ESTIMATED_TOKENS} from "../images/content.js";
// Token 估算工具
// 参考 claude-code src/services/tokenEstimation.ts:203-208 的 roughTokenCountEstimation
// 和 src/utils/tokens.ts:230-265 的 tokenCountWithEstimation
//
// 设计决策：简化版直接从头估算所有消息，不用 lastUsage 增量计算。
// 原因：阈值检查不需要精确，误差可接受；lastUsage 增量逻辑复杂（要找上次 assistant
// 消息位置、避免重复计算 completion_tokens），收益不大。
// UI 显示的真实 token 数直接用 agent/runner.ts 里 usage.prompt_tokens（API 返回）。

import type {Message, OpenAITool} from "../llm/types.js";

// 使用 chars/2，比英文为主的 chars/4 更保守。
// 原因：本项目主要中文交互，CJK 文本按 chars/4 会明显低估，导致 Auto-Compact 触发偏晚。
const DEFAULT_ESTIMATION_CHARS_PER_TOKEN = 2;

// chars/N 粗估。参数名保留 bytesPerToken，是为了兼容 claude-code 的命名。
function roughTokenCountEstimation(
    content: string,
    bytesPerToken: number = DEFAULT_ESTIMATION_CHARS_PER_TOKEN
): number {
    return Math.round(content.length / bytesPerToken);
}

// 单条 message token 估算（递归 content + tool_calls）
export function estimateMessageTokens(msg: Message): number {
    let total = 0;

    // content 可能是 string / null / undefined
    if (typeof msg.content === "string") {
        total += roughTokenCountEstimation(msg.content);
    }

    if (Array.isArray(msg.content)) total += roughTokenCountEstimation(contentText(msg.content)) + imageReferences(msg.content).length * IMAGE_ESTIMATED_TOKENS;

    // assistant 的 tool_calls 也要算（JSON 序列化后估算）
    if (msg.role === "assistant" && msg.tool_calls) {
        total += roughTokenCountEstimation(JSON.stringify(msg.tool_calls));
    }
    if (msg.role === "assistant" && msg.reasoning_content) {
        total += roughTokenCountEstimation(msg.reasoning_content);
    }

    return total;
}

// 估算 tools schema 的 token 数
// LLM 请求里的 tools 字段也占 token，且往往比 messages 还大（每个工具的 description + parameters）
// claude-code 在 tokenCountWithEstimation 里没单独算 tools，但它的 splitSysPromptPrefix 把
// tools 作为 cache scope 的一部分。我们简化版单独算。
function estimateToolsTokens(tools: OpenAITool[]): number {
    return roughTokenCountEstimation(JSON.stringify(tools));
}

// 全量估算：累加所有消息 + tools schema 的 token
// 用于阈值检查（要不要触发压缩/警告）
// tools schema 算进去——工具描述和参数 schema 也会占用不少 token，不可忽略
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
