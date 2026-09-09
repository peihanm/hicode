import type {TurnInput} from "../images/input.js";
import type {McpServerSnapshot} from "../mcp/index.js";
import type {PermissionMode} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {SandboxStatus} from "../sandbox/types.js";
import type {
    InteractionRequest,
    InteractionResponse,
    ThreadEvent,
    ThreadItem,
    Usage,
} from "./protocol.js";
import type {StopReason} from "../agent/types.js";
import type {TurnAbortReason} from "../runtime/abort.js";
import type {PillarRootConfiguration} from "../runtime/rootConfiguration.js";
import type {ZodType} from "zod";

export interface HostDiagnostic {
    severity: "info" | "warning" | "error";
    scope: "runtime" | "sandbox" | "agent" | "hook" | "session";
    message: string;
}

export interface InteractionContext {
    cwd: string;
    threadId?: string;
    turnId?: string;
}

export interface PillarHost {
    onInteraction?(
        request: InteractionRequest,
        context: InteractionContext
    ): Promise<InteractionResponse>;

    onDiagnostic?(
        diagnostic: HostDiagnostic
    ): void | Promise<void>;
}

export interface PillarHostToolContext {
    readonly cwd: string;
    readonly threadId: string;
    readonly toolCallId: string;
    readonly signal: AbortSignal;
}

export type PillarHostToolOutput =
    | string
    | {
    content: string;
    outcome?: "ok" | "failed";
};

export interface PillarHostTool<TInput = unknown> {
    readonly name: string;
    readonly description: string;
    readonly parameters: ZodType<TInput>;
    readonly readOnly: boolean;
    readonly concurrencySafe?: boolean;
    readonly maxResultSizeChars?: number;

    execute(
        input: TInput,
        context: PillarHostToolContext
    ): PillarHostToolOutput | Promise<PillarHostToolOutput>;
}

export interface PillarOptions {
    configuration: PillarRootConfiguration;
    host?: PillarHost;
    tools?: readonly PillarHostTool[];
}

export interface StartThreadOptions {
    permissionMode?: PermissionMode;
    collaborationMode?: CollaborationMode;
}

export interface TurnOptions {
    signal?: AbortSignal;
    permissionMode?: PermissionMode;
    collaborationMode?: CollaborationMode;
    maxIterations?: number;
}

export interface ThreadInfo {
    id: string;
    cwd: string;
    model: string;
    provider: string;
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    sandbox: SandboxStatus;
    mcpServers: readonly McpServerSnapshot[];
    resumed: boolean;
}

export interface TurnResult {
    threadId: string;
    turnId: string;
    items: ThreadItem[];
    finalResponse: string;
    usage: Usage | null;
    stopReason: StopReason;
    abortReason?: TurnAbortReason;
    iterations: number;
    durationMs: number;
}

export interface StreamedTurn {
    events: AsyncGenerator<ThreadEvent>;
}

export interface Thread {
    readonly id: string;

    getInfo(): ThreadInfo;

    run(input: TurnInput, options?: TurnOptions): Promise<TurnResult>;

    runStreamed(input: TurnInput, options?: TurnOptions): Promise<StreamedTurn>;

    close(): Promise<void>;
}

export class PillarSDKError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "PillarSDKError";
        this.code = code;
    }
}
