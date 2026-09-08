import {z} from "zod";
import type {PersistedBinaryArtifact} from "./types.js";
import {storedImageSchema} from "../images/content.js";

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

export const binaryOriginSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("tool"), toolCallId: z.string().min(1).max(512), toolName: z.string().min(1).max(256)}).strict(),
    z.object({kind: z.literal("user"), inputId: z.string().uuid()}).strict(),
]);

function hasValidLengths(value: Record<string, unknown>): boolean {
    return isValidLength(value.byteLength) && isValidLength(value.originalByteLength) &&
        value.originalByteLength >= value.byteLength && typeof value.complete === "boolean" &&
        (!value.complete || value.originalByteLength === value.byteLength);
}

function hasValidCommonMetadata(value: Record<string, unknown>): boolean {
    return typeof value.toolCallId === "string" && value.toolCallId.length > 0 && value.toolCallId.length <= 512 &&
        typeof value.toolName === "string" && value.toolName.length > 0 && value.toolName.length <= 256 && hasValidLengths(value);
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
        return {
            resultId: expectedResultId,
            toolCallId: value.toolCallId as string,
            toolName: value.toolName as string,
            byteLength: value.byteLength as number,
            originalByteLength: value.originalByteLength as number,
            complete: value.complete as boolean,
            encoding: "utf-8",
        };
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
            typeof value.path !== "string" || value.path.length > 16_384 ||
            typeof value.mimeType !== "string" ||
            value.mimeType.length === 0 || value.mimeType.length > 256 ||
            !hasValidLengths(value)
        ) {
            return null;
        }
        const origin = binaryOriginSchema.parse(value.origin);
        const image = value.image === undefined ? undefined : storedImageSchema.parse(value.image);
        if (image && (!value.complete || image.byteLength !== value.byteLength || image.mimeType !== value.mimeType)) return null;
        return {
            artifactId: expectedArtifactId,
            origin,
            path: value.path,
            byteLength: value.byteLength as number,
            originalByteLength: value.originalByteLength as number,
            complete: value.complete as boolean,
            encoding: "binary",
            mimeType: value.mimeType,
            ...(image ? {image} : {}),
        };
    } catch {
        return null;
    }
}
