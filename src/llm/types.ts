import type {LLMProviderName} from "./providerRegistry.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ImageReference, MessageContent} from "../images/content.js";

// Conversation messages carry framework provenance; the Provider wire encoder
// projects it away. Function calls are validated before ToolRuntime execution.
export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        /** Raw JSON string. ToolRuntime parses and validates it before execution. */
        arguments: string;
    };
}

export type UserMessageOrigin = "user" | "task_notification" | "runtime" | "compaction" | "agent";

export type Message =
    | { role: "system"; content: string }
    | { role: "user"; origin: UserMessageOrigin; content: MessageContent }
    | {
        role: "assistant";
        content: string | null;
        tool_calls?: ToolCall[];
        /** DeepSeek thinking tool turns must send this back on later requests. */
        reasoning_content?: string;
    }
    | { role: "tool"; content: MessageContent; tool_call_id: string };

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/** Latest active model context, distinct from accumulated billable usage. */
export interface LLMContextUsage {
    /** Input of the last successful request, excluding retry billing and generated output. */
    inputTokens: number;
    tokenCount: number;
    contextWindow?: number;
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

export interface LLMRetryInfo {
    reason: "connection" | "http" | "empty_response" | "output_stall" | "stream_disconnected" | "empty_stream" | "invalid_json" | "protocol";
    attempt: number;
    maxAttempts: number;
}

export interface LLMStreamProgress {
    phase: LLMStreamPhase;
    outputCharacters: number;
    estimatedOutputTokens: number;
    toolName?: string;
    idleMilliseconds?: number;
    retry?: LLMRetryInfo;
}

export type LLMTextUpdate = {type: "reset"} | {type: "delta"; text: string};

export interface LLMCallOptions {
    storage: PillarStorageLayout;
    messages: Message[];
    tools: OpenAITool[];
    cwd: string;
    model: string;
    kind: LLMCallKind;
    signal?: AbortSignal;
    /** Report cumulative progress when receiving text, reasoning or function-argument deltas. */
    onStreamProgress?: (progress: LLMStreamProgress) => void;
    onText?: (update: LLMTextUpdate) => void | Promise<void>;
    readImage?: (reference: ImageReference) => Promise<Buffer>;
}

export interface LLMCallResult {
    message: Message;
    toolCalls: ToolCall[];
    usage: TokenUsage;
    contextUsage?: LLMContextUsage;
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
    onStreamProgress?: (progress: LLMStreamProgress) => void,
    onText?: (update: LLMTextUpdate) => void | Promise<void>,
    readImage?: (reference: ImageReference) => Promise<Buffer>
) => Promise<LLMCallResult>;

export interface LLMProvider {
    name: LLMProviderName;

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
    | {
        usage: TokenUsage;
        contextUsage?: LLMContextUsage;
        rawMessage: unknown;
        rawResponse: unknown;
    }
    | { error: string };

export interface PromptLogPendingResponse {
    status: "pending";
}
