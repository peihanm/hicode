import type {ToolUIData} from "../fileChanges/index.js";
import type {ImageDescriptor, MessageContent} from "../images/content.js";

export const DEFAULT_MAX_RESULT_CHARS = 50_000;
export const DEFAULT_PREVIEW_CHARS = 2_000;
export const DEFAULT_DISPLAY_CHARS = 10_000;
export const MAX_TOOL_RESULTS_PER_BATCH_CHARS = 200_000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_SESSION_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface PersistedToolResult {
    resultId: string;
    toolCallId: string;
    toolName: string;
    path: string;
    byteLength: number;
    originalByteLength: number;
    preview: string;
    complete: boolean;
    encoding: "utf-8";
}

export type BinaryArtifactOrigin =
    | {kind: "tool"; toolCallId: string; toolName: string}
    | {kind: "user"; inputId: string};

export interface PersistedBinaryArtifact {
    artifactId: string;
    origin: BinaryArtifactOrigin;
    path: string;
    byteLength: number;
    originalByteLength: number;
    complete: boolean;
    encoding: "binary";
    mimeType: string;
    image?: ImageDescriptor;
}

export type ToolOutcome = "ok" | "failed" | "denied" | "interrupted";

export interface ShellExecutionEvidence {
    command: string;
    cwd: string;
    sandboxPermissions: "use_default" | "require_escalated";
}

export type ToolOutput =
    | string
    | {
    content: MessageContent;
    displayContent?: string;
    persisted?: PersistedToolResult;
    outcome?: ToolOutcome;
    uiData?: ToolUIData;
    shellExecution?: ShellExecutionEvidence;
};

export interface ToolExecutionResult {
    modelContent: MessageContent;
    displayContent: string;
    outcome: ToolOutcome;
    persisted?: PersistedToolResult;
    uiData?: ToolUIData;
    shellExecution?: ShellExecutionEvidence;
    untrackedWorkspaceEffects?: boolean;
}

export interface ToolResultStoreLimits {
    maxArtifactBytes: number;
    maxSessionBytes: number;
    previewChars: number;
}

export class ToolResultStoreError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ToolResultStoreError";
    }
}
