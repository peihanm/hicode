import type {ToolUIData} from "../fileChanges/index.js";

export const DEFAULT_MAX_RESULT_CHARS = 50_000;
export const DEFAULT_PREVIEW_CHARS = 2_000;
export const DEFAULT_DISPLAY_CHARS = 10_000;
export const MAX_TOOL_RESULTS_PER_BATCH_CHARS = 200_000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_SESSION_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_RESULT_READ_BYTES = 16 * 1024;
export const MAX_RESULT_READ_BYTES = 64 * 1024;

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

export interface PersistedBinaryArtifact {
    artifactId: string;
    toolCallId: string;
    toolName: string;
    path: string;
    byteLength: number;
    originalByteLength: number;
    complete: boolean;
    encoding: "binary";
    mimeType: string;
}

export interface ToolResultChunk {
    resultId: string;
    content: string;
    offset: number;
    nextOffset: number;
    byteLength: number;
    eof: boolean;
    complete: boolean;
}

export type ToolOutcome = "ok" | "failed" | "denied" | "interrupted";

export type ToolOutput =
    | string
    | {
    content: string;
    displayContent?: string;
    persisted?: PersistedToolResult;
    outcome?: ToolOutcome;
    uiData?: ToolUIData;
};

export interface ToolExecutionResult {
    modelContent: string;
    displayContent: string;
    outcome: ToolOutcome;
    persisted?: PersistedToolResult;
    uiData?: ToolUIData;
}

export interface ToolResultStoreOptions {
    /** Host-owned projects root; tests and embedded hosts use an isolated root. */
    rootDir?: string;
    maxArtifactBytes?: number;
    maxSessionBytes?: number;
    previewChars?: number;
}

export class ToolResultStoreError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ToolResultStoreError";
    }
}
