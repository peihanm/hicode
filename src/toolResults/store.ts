import {createHash, randomUUID} from "node:crypto";
import {isUtf8} from "node:buffer";
import {chmod, link, lstat, mkdir, open, readdir, readFile, rm, stat, truncate, writeFile,} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {withFileLock} from "../persistence/index.js";
import {getArtifactKey, getResultId, getToolResultSessionDir,} from "./paths.js";
import {createPreview} from "./format.js";
import {
    parseBinaryArtifactMetadata,
    parseTextArtifactMetadata,
    type TextArtifactMetadata,
} from "./artifactMetadata.js";
import {selectUtf8Range, trimIncompleteUtf8} from "./utf8.js";
import {
    DEFAULT_MAX_ARTIFACT_BYTES,
    DEFAULT_MAX_SESSION_ARTIFACT_BYTES,
    DEFAULT_PREVIEW_CHARS,
    type PersistedBinaryArtifact,
    type PersistedToolResult,
    type ToolResultChunk,
    ToolResultStoreError,
    type ToolResultStoreLimits,
} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";

const MAX_TOOL_RESULT_METADATA_BYTES = 64 * 1024;
const MAX_TOOL_RESULT_DIRECTORY_ENTRIES = 20_000;

function assertNonNegativeLimit(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
}

function assertPositiveLimit(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
}

function isAlreadyExists(error: unknown): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
    );
}

function isCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === code
    );
}

export class ToolResultStore {
    readonly sessionDir: string;
    readonly maxArtifactBytes: number;
    readonly maxSessionBytes: number;
    readonly previewChars: number;
    readonly sessionId: string;
    private temporaryFilesCleaned = false;

    constructor(
        storage: PillarStorageLayout,
        readonly cwd: string,
        sessionId: string,
        limits: ToolResultStoreLimits
    ) {
        this.sessionId = sessionId;
        this.sessionDir = getToolResultSessionDir(storage, cwd, sessionId);
        this.maxArtifactBytes = limits.maxArtifactBytes;
        this.maxSessionBytes = limits.maxSessionBytes;
        this.previewChars = limits.previewChars;
        assertNonNegativeLimit(this.maxArtifactBytes, "maxArtifactBytes");
        assertNonNegativeLimit(this.maxSessionBytes, "maxSessionBytes");
        assertPositiveLimit(this.previewChars, "previewChars");
    }

    static create(
        storage: PillarStorageLayout,
        cwd: string,
        sessionId: string
    ): ToolResultStore {
        return new ToolResultStore(storage, cwd, sessionId, {
            maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES,
            maxSessionBytes: DEFAULT_MAX_SESSION_ARTIFACT_BYTES,
            previewChars: DEFAULT_PREVIEW_CHARS,
        });
    }

    resultIdFor(toolCallId: string): string {
        return getResultId(toolCallId);
    }

    private paths(resultId: string): { content: string; metadata: string } {
        const key = getArtifactKey(this.sessionId, resultId);
        return {
            content: join(this.sessionDir, `${key}.txt`),
            metadata: join(this.sessionDir, `${key}.meta.json`),
        };
    }

    private async ensureDir(): Promise<void> {
        await mkdir(this.sessionDir, {recursive: true, mode: 0o700});
        const directory = await lstat(this.sessionDir);
        if (!directory.isDirectory() || directory.isSymbolicLink()) {
            throw new ToolResultStoreError("tool result session directory is not safe");
        }
        await chmod(this.sessionDir, 0o700);
        if (this.temporaryFilesCleaned) return;
        this.temporaryFilesCleaned = true;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        try {
            const entries = await readdir(this.sessionDir, {withFileTypes: true});
            if (entries.length > MAX_TOOL_RESULT_DIRECTORY_ENTRIES) {
                throw new ToolResultStoreError("tool result directory entry limit exceeded");
            }
            await Promise.all(
                entries
                    .filter((entry) => entry.isFile() && entry.name.startsWith(".tmp-"))
                    .map(async (entry) => {
                        const path = join(this.sessionDir, entry.name);
                        if ((await stat(path)).mtimeMs < cutoff) {
                            await rm(path, {force: true});
                        }
                    })
            );
        } catch (error) {
            if (error instanceof ToolResultStoreError) throw error;
            // Cleanup is best-effort; a stale temp must not block a new tool result.
        }
    }

    private async currentUsage(): Promise<number> {
        try {
            const entries = await readdir(this.sessionDir, {withFileTypes: true});
            if (entries.length > MAX_TOOL_RESULT_DIRECTORY_ENTRIES) {
                throw new ToolResultStoreError("tool result directory entry limit exceeded");
            }
            let total = 0;
            for (const entry of entries) {
                if (
                    !entry.isFile() ||
                    (!entry.name.endsWith(".txt") && !entry.name.endsWith(".bin"))
                ) continue;
                const metadataName = entry.name.endsWith(".txt")
                    ? `${entry.name.slice(0, -4)}.meta.json`
                    : `${entry.name.slice(0, -4)}.binary.json`;
                try {
                    const [content, metadata] = await Promise.all([
                        lstat(join(this.sessionDir, entry.name)),
                        lstat(join(this.sessionDir, metadataName)),
                    ]);
                    if (
                        content.isFile() && !content.isSymbolicLink() &&
                        metadata.isFile() && !metadata.isSymbolicLink()
                    ) total += content.size;
                } catch (error) {
                    if (!isCode(error, "ENOENT")) throw error;
                }
            }
            return total;
        } catch (error) {
            if (isCode(error, "ENOENT")) return 0;
            throw error;
        }
    }

    private async readMetadata(resultId: string): Promise<TextArtifactMetadata | null> {
        try {
            const path = this.paths(resultId).metadata;
            const metadata = await lstat(path);
            if (
                !metadata.isFile() ||
                metadata.isSymbolicLink() ||
                metadata.size > MAX_TOOL_RESULT_METADATA_BYTES
            ) return null;
            return parseTextArtifactMetadata(
                await readFile(path, "utf8"),
                resultId
            );
        } catch {
            return null;
        }
    }

    private async loadExisting(
        resultId: string
    ): Promise<PersistedToolResult | null> {
        const metadata = await this.readMetadata(resultId);
        if (!metadata) return null;
        try {
            const content = await lstat(this.paths(resultId).content);
            if (
                !content.isFile() ||
                content.isSymbolicLink() ||
                content.size !== metadata.byteLength
            ) {
                return null;
            }
            return await this.toPersistedResult(metadata, this.paths(resultId).content);
        } catch {
            return null;
        }
    }

    private async toPersistedResult(
        metadata: TextArtifactMetadata,
        contentPath: string
    ): Promise<PersistedToolResult> {
        const handle = await open(contentPath, "r");
        try {
            const previewBuffer = Buffer.alloc(Math.max(this.previewChars * 4, 4096));
            const {bytesRead} = await handle.read(previewBuffer, 0, previewBuffer.length, 0);
            const preview = createPreview(
                trimIncompleteUtf8(previewBuffer.subarray(0, bytesRead)).toString("utf8"),
                this.previewChars
            );
            return {...metadata, path: contentPath, preview};
        } finally {
            await handle.close();
        }
    }

    private async loadExistingBinary(
        artifactId: string,
        contentPath: string,
        metadataPath: string
    ): Promise<PersistedBinaryArtifact | null> {
        try {
            const [content, metadataFile] = await Promise.all([
                lstat(contentPath),
                lstat(metadataPath),
            ]);
            if (
                !content.isFile() || content.isSymbolicLink() ||
                !metadataFile.isFile() || metadataFile.isSymbolicLink() ||
                metadataFile.size > MAX_TOOL_RESULT_METADATA_BYTES
            ) return null;
            const metadata = parseBinaryArtifactMetadata(
                await readFile(metadataPath, "utf8"),
                artifactId
            );
            if (!metadata || content.size !== metadata.byteLength) {
                return null;
            }
            return {...metadata, path: contentPath};
        } catch {
            return null;
        }
    }

    private async removePair(contentPath: string, metadataPath: string): Promise<void> {
        await Promise.all([
            rm(contentPath, {force: true}),
            rm(metadataPath, {force: true}),
        ]);
    }

    private async withMutation<T>(action: () => Promise<T>): Promise<T> {
        await this.ensureDir();
        return withFileLock(join(this.sessionDir, ".store.lock"), async () => {
            await this.ensureDir();
            return action();
        });
    }

    private async publishPair(
        tempContentPath: string,
        tempMetadataPath: string,
        contentPath: string,
        metadataPath: string
    ): Promise<void> {
        try {
            try {
                await link(tempContentPath, contentPath);
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
            }
            try {
                await link(tempMetadataPath, metadataPath);
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
            }
        } catch (error) {
            await this.removePair(contentPath, metadataPath);
            throw error;
        }
    }

    async persistText(input: {
        toolCallId: string;
        toolName: string;
        content: string;
        resultId?: string;
    }): Promise<PersistedToolResult> {
        return this.withMutation(async () => {
            const resultId = input.resultId ?? this.resultIdFor(input.toolCallId);
            const paths = this.paths(resultId);
            const existing = await this.loadExisting(resultId);
            if (existing) return existing;
            await this.removePair(paths.content, paths.metadata);

            const original = Buffer.from(input.content, "utf8");
            const usage = await this.currentUsage();
            const remainingSessionBytes = Math.max(0, this.maxSessionBytes - usage);
            const allowed = Math.min(this.maxArtifactBytes, remainingSessionBytes);
            if (allowed <= 0) {
                throw new ToolResultStoreError("tool result session quota exceeded");
            }
            const storedBuffer = trimIncompleteUtf8(original.subarray(0, allowed));
            const metadata: TextArtifactMetadata = {
                resultId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                byteLength: storedBuffer.length,
                originalByteLength: original.length,
                complete: storedBuffer.length === original.length,
                encoding: "utf-8",
            };
            const tempContent = join(this.sessionDir, `.tmp-${randomUUID()}`);
            const tempMetadata = join(this.sessionDir, `.tmp-${randomUUID()}`);
            try {
                await writeFile(tempContent, storedBuffer, {flag: "wx", mode: 0o600});
                await writeFile(tempMetadata, `${JSON.stringify(metadata)}\n`, {
                    flag: "wx",
                    mode: 0o600,
                });
                await this.publishPair(
                    tempContent,
                    tempMetadata,
                    paths.content,
                    paths.metadata
                );
                const committed = await this.loadExisting(resultId);
                if (!committed) {
                    await this.removePair(paths.content, paths.metadata);
                    throw new ToolResultStoreError(
                        `failed to commit tool result: ${resultId}`
                    );
                }
                return committed;
            } finally {
                await rm(tempContent, {force: true});
                await rm(tempMetadata, {force: true});
            }
        });
    }

    async persistBinary(input: {
        toolCallId: string;
        toolName: string;
        data: Buffer;
        mimeType: string;
        artifactId?: string;
    }): Promise<PersistedBinaryArtifact> {
        return this.withMutation(async () => {
            const artifactId = input.artifactId ??
                `${this.resultIdFor(input.toolCallId)}-binary`;
            const key = getArtifactKey(this.sessionId, artifactId);
            const contentPath = join(this.sessionDir, `${key}.bin`);
            const metadataPath = join(this.sessionDir, `${key}.binary.json`);
            const existing = await this.loadExistingBinary(
                artifactId,
                contentPath,
                metadataPath
            );
            if (existing) return existing;
            await this.removePair(contentPath, metadataPath);

            const usage = await this.currentUsage();
            const remainingSessionBytes = Math.max(0, this.maxSessionBytes - usage);
            const allowed = Math.min(this.maxArtifactBytes, remainingSessionBytes);
            if (allowed <= 0) {
                throw new ToolResultStoreError("tool result session quota exceeded");
            }
            const stored = input.data.subarray(0, allowed);
            const metadata: PersistedBinaryArtifact = {
                artifactId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                path: contentPath,
                byteLength: stored.byteLength,
                originalByteLength: input.data.byteLength,
                complete: stored.byteLength === input.data.byteLength,
                encoding: "binary",
                mimeType: input.mimeType,
            };
            const tempContent = join(this.sessionDir, `.tmp-${randomUUID()}`);
            const tempMetadata = join(this.sessionDir, `.tmp-${randomUUID()}`);
            try {
                await writeFile(tempContent, stored, {flag: "wx", mode: 0o600});
                await writeFile(tempMetadata, `${JSON.stringify(metadata)}\n`, {
                    flag: "wx",
                    mode: 0o600,
                });
                await this.publishPair(
                    tempContent,
                    tempMetadata,
                    contentPath,
                    metadataPath
                );
                const committed = await this.loadExistingBinary(
                    artifactId,
                    contentPath,
                    metadataPath
                );
                if (!committed) {
                    await this.removePair(contentPath, metadataPath);
                    throw new ToolResultStoreError(
                        `failed to commit binary artifact: ${artifactId}`
                    );
                }
                return committed;
            } finally {
                await rm(tempContent, {force: true});
                await rm(tempMetadata, {force: true});
            }
        });
    }

    async promoteFile(input: {
        toolCallId: string;
        toolName: string;
        sourcePath: string;
        originalByteLength?: number;
        complete?: boolean;
        resultId?: string;
    }): Promise<PersistedToolResult> {
        const resolvedSource = resolve(input.sourcePath);
        if (
            dirname(resolvedSource) !== resolve(this.sessionDir) ||
            !basename(resolvedSource).startsWith(".tmp-")
        ) {
            throw new ToolResultStoreError("capture path is outside the current session");
        }
        return this.withMutation(async () => {
            const resultId = input.resultId ?? this.resultIdFor(input.toolCallId);
            const paths = this.paths(resultId);
            const existing = await this.loadExisting(resultId);
            if (existing) return existing;
            await this.removePair(paths.content, paths.metadata);

            const sourceStat = await lstat(input.sourcePath);
            if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
                throw new ToolResultStoreError("capture path is not a regular file");
            }
            const originalByteLength = Math.max(
                input.originalByteLength ?? sourceStat.size,
                sourceStat.size
            );
            const usage = await this.currentUsage();
            const remainingSessionBytes = Math.max(0, this.maxSessionBytes - usage);
            const allowed = Math.min(this.maxArtifactBytes, remainingSessionBytes);
            if (allowed <= 0) {
                throw new ToolResultStoreError("tool result session quota exceeded");
            }
            let storedSize = Math.min(sourceStat.size, allowed);
            const handle = await open(input.sourcePath, "r");
            try {
                const tail = Buffer.alloc(Math.min(4, storedSize));
                const {bytesRead} = await handle.read(tail, 0, tail.length, storedSize - tail.length);
                if (bytesRead !== tail.length) throw new ToolResultStoreError("capture changed before publication");
                storedSize -= tail.length - trimIncompleteUtf8(tail).length;
            } finally {
                await handle.close();
            }
            if (sourceStat.size !== storedSize) await truncate(input.sourcePath, storedSize);
            const metadata: TextArtifactMetadata = {
                resultId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                byteLength: storedSize,
                originalByteLength,
                complete:
                    input.complete !== false && storedSize === originalByteLength,
                encoding: "utf-8",
            };
            const tempMetadata = join(this.sessionDir, `.tmp-${randomUUID()}`);
            try {
                await writeFile(tempMetadata, `${JSON.stringify(metadata)}\n`, {
                    flag: "wx",
                    mode: 0o600,
                });
                await this.publishPair(
                    resolvedSource,
                    tempMetadata,
                    paths.content,
                    paths.metadata
                );
                const committed = await this.loadExisting(resultId);
                if (!committed) {
                    await this.removePair(paths.content, paths.metadata);
                    throw new ToolResultStoreError(
                        `failed to commit tool result: ${resultId}`
                    );
                }
                return committed;
            } finally {
                await rm(tempMetadata, {force: true});
            }
        });
    }

    async createCapture(): Promise<string> {
        await this.ensureDir();
        const path = join(this.sessionDir, `.tmp-${randomUUID()}`);
        const handle = await open(path, "wx", 0o600);
        await handle.close();
        return path;
    }

    async readRange(input: {
        resultId: string;
        offset: number;
        limit: number;
        expectedHash?: string;
    }): Promise<ToolResultChunk> {
        if (
            !Number.isSafeInteger(input.offset) || input.offset < 0 ||
            !Number.isSafeInteger(input.limit) || input.limit <= 0
        ) {
            throw new ToolResultStoreError("offset and limit must be positive byte ranges");
        }
        const paths = this.paths(input.resultId);
        const metadata = await this.readMetadata(input.resultId);
        if (!metadata) {
            throw new ToolResultStoreError(`tool result not found: ${input.resultId}`);
        }
        if (input.offset > metadata.byteLength) {
            throw new ToolResultStoreError(
                `offset ${input.offset} exceeds result size ${metadata.byteLength}`
            );
        }
        try {
            const content = await lstat(paths.content);
            if (
                !content.isFile() ||
                content.isSymbolicLink() ||
                content.size !== metadata.byteLength
            ) {
                throw new ToolResultStoreError(
                    `tool result content is invalid: ${input.resultId}`
                );
            }
        } catch (error) {
            if (error instanceof ToolResultStoreError) throw error;
            throw new ToolResultStoreError(
                `tool result content is missing: ${input.resultId}`,
                {cause: error}
            );
        }
        let handle;
        try {
            handle = await open(paths.content, "r");
        } catch (error) {
            throw new ToolResultStoreError(
                `tool result content is missing: ${input.resultId}`,
                {cause: error}
            );
        }
        try {
            const readLimit = Math.min(
                // Up to three skipped continuation bytes plus a full next character.
                input.limit + 6,
                metadata.byteLength - input.offset
            );
            const buffer = Buffer.alloc(readLimit);
            let bytesRead: number;
            if (input.expectedHash !== undefined) {
                if (!/^[a-f0-9]{64}$/.test(input.expectedHash)) throw new ToolResultStoreError("invalid expected artifact hash");
                const digest = createHash("sha256");
                const block = Buffer.alloc(64 * 1024);
                let position = 0;
                bytesRead = 0;
                while (position < metadata.byteLength) {
                    const read = await handle.read(block, 0, Math.min(block.length, metadata.byteLength - position), position);
                    if (read.bytesRead === 0) break;
                    digest.update(block.subarray(0, read.bytesRead));
                    const start = Math.max(position, input.offset);
                    const end = Math.min(position + read.bytesRead, input.offset + readLimit);
                    if (end > start) {
                        block.copy(buffer, start - input.offset, start - position, end - position);
                        bytesRead += end - start;
                    }
                    position += read.bytesRead;
                }
                if (position !== metadata.byteLength || digest.digest("hex") !== input.expectedHash) {
                    throw new ToolResultStoreError("file evidence artifact hash mismatch; read_file again");
                }
            } else {
                ({bytesRead} = await handle.read(buffer, 0, readLimit, input.offset));
            }
            const {content: safe, startAdjustment} = selectUtf8Range(
                buffer.subarray(0, bytesRead),
                input.limit
            );
            const offset = input.offset + startAdjustment;
            const nextOffset = input.offset + startAdjustment + safe.length;
            if (!isUtf8(safe) || (nextOffset < metadata.byteLength && safe.length === 0)) {
                throw new ToolResultStoreError(`tool result contains invalid or incomplete UTF-8: ${input.resultId}`);
            }
            return {
                resultId: input.resultId,
                content: safe.toString("utf8"),
                offset,
                nextOffset,
                byteLength: metadata.byteLength,
                eof: nextOffset >= metadata.byteLength,
                complete: metadata.complete,
            };
        } finally {
            await handle.close();
        }
    }

    async removeTemporaryFile(path: string): Promise<void> {
        const resolvedPath = resolve(path);
        if (
            dirname(resolvedPath) === resolve(this.sessionDir) &&
            basename(resolvedPath).startsWith(".tmp-")
        ) {
            await rm(resolvedPath, {force: true});
        }
    }

    async removeArtifact(resultId: string): Promise<void> {
        const paths = this.paths(resultId);
        await this.withMutation(() => this.removePair(paths.content, paths.metadata));
    }
}

export const createToolResultStore = ToolResultStore.create;
