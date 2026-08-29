import type {LLMProviderName} from "./providerRegistry.js";
import type {PillarStorageLayout} from "../persistence/index.js";

// OpenAI-compatible chat message and Function Calling protocols belong to the
// LLM boundary. Agent/UI application types live in their owning modules.
export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        /** Raw JSON string. ToolRuntime parses and validates it before execution. */
        arguments: string;
    };
}

export type Message =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | {
        role: "assistant";
        content: string | null;
        tool_calls?: ToolCall[];
        /** DeepSeek thinking tool turns must send this back on later requests. */
        reasoning_content?: string;
    }
    | { role: "tool"; content: string; tool_call_id: string };

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export type LLMCallKind =
    | "main"
    | "compact"
    | "memory"
    | "agent_authoring"
    | "hook";

type LLMStreamPhase =
    | "reasoning"
    | "content"
    | "tool_input"
    | "retrying"
    | "stalled";

export interface LLMStreamProgress {
    phase: LLMStreamPhase;
    outputCharacters: number;
    estimatedOutputTokens: number;
    toolName?: string;
    idleMilliseconds?: number;
}

export interface LLMCallOptions {
    storage: PillarStorageLayout;
    messages: Message[];
    tools: OpenAITool[];
    cwd: string;
    model: string;
    kind: LLMCallKind;
    signal?: AbortSignal;
    /** 收到文本、推理或 Function Calling 参数增量时报告累计进度。 */
    onStreamProgress?: (progress: LLMStreamProgress) => void;
}

export interface LLMCallResult {
    message: Message;
    toolCalls: ToolCall[];
    usage: TokenUsage;
}

export interface LLMSourceConnection {
    id: LLMProviderName;
    label: string;
    apiKeyEnv: string;
    baseUrl?: string;
}

export type LLMCaller = (
    messages: Message[],
    tools: OpenAITool[],
    storage: PillarStorageLayout,
    cwd: string,
    model: string,
    kind: LLMCallKind,
    signal?: AbortSignal,
    onStreamProgress?: (progress: LLMStreamProgress) => void
) => Promise<LLMCallResult>;

export interface LLMProvider {
    name: LLMProviderName;

    supports(model: string): boolean;

    call(
        options: LLMCallOptions,
        source: LLMSourceConnection
    ): Promise<LLMCallResult>;
}

export interface PromptLogRequest {
    messages: unknown[];
    tools?: unknown[];
    [key: string]: unknown;
}

export type PromptLogResponse =
    | { usage: TokenUsage; rawMessage: unknown; rawResponse: unknown }
    | { error: string };

export interface PromptLogPendingResponse {
    status: "pending";
}
