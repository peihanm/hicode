import type {PersistedBinaryArtifact} from "./types.js";

export interface TextArtifactMetadata {
    resultId: string;
    toolCallId: string;
    toolName: string;
    byteLength: number;
    originalByteLength: number;
    complete: boolean;
    encoding: "utf-8";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidLength(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidCommonMetadata(value: Record<string, unknown>): boolean {
    return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        isValidLength(value.byteLength) &&
        isValidLength(value.originalByteLength) &&
        value.originalByteLength >= value.byteLength &&
        typeof value.complete === "boolean" &&
        (!value.complete || value.originalByteLength === value.byteLength)
    );
}

export function parseTextArtifactMetadata(
    content: string,
    expectedResultId: string
): TextArtifactMetadata | null {
    try {
        const value: unknown = JSON.parse(content);
        if (
            !isRecord(value) ||
            value.resultId !== expectedResultId ||
            value.encoding !== "utf-8" ||
            !hasValidCommonMetadata(value)
        ) {
            return null;
        }
        return value as unknown as TextArtifactMetadata;
    } catch {
        return null;
    }
}

export function parseBinaryArtifactMetadata(
    content: string,
    expectedArtifactId: string
): PersistedBinaryArtifact | null {
    try {
        const value: unknown = JSON.parse(content);
        if (
            !isRecord(value) ||
            value.artifactId !== expectedArtifactId ||
            value.encoding !== "binary" ||
            typeof value.path !== "string" ||
            typeof value.mimeType !== "string" ||
            !hasValidCommonMetadata(value)
        ) {
            return null;
        }
        return value as unknown as PersistedBinaryArtifact;
    } catch {
        return null;
    }
}
