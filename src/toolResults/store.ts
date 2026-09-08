import {constants} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import {imageDescriptorSchema, imageReferenceSchema, type ImageDescriptor, type ImageReference} from "../images/content.js";
import {chmod, link, lstat, open, readdir, readFile, rm, stat, truncate, writeFile,} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, relative, resolve} from "node:path";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile, withFileLock} from "../persistence/index.js";
import {getArtifactKey, getResultId, getToolResultSessionDir,} from "./paths.js";
import {createPreview} from "./format.js";
import {
    binaryOriginSchema,
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
    private readonly projectsRoot: string;

    constructor(
        private readonly storage: PillarStorageLayout,
        readonly cwd: string,
        sessionId: string,
        limits: ToolResultStoreLimits
    ) {
        this.sessionId = sessionId;
        this.projectsRoot = storage.projectsRoot;
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
        ensurePrivateStorageDirectory(this.storage, this.sessionDir);
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
            const sampleBytes = Math.min(metadata.byteLength, Math.max(this.previewChars * 4, 4096));
            const readSample = async (position: number): Promise<Buffer> => {
                const buffer = Buffer.alloc(sampleBytes);
                let offset = 0;
                while (offset < buffer.length) {
                    const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, position + offset);
                    if (bytesRead === 0) throw new ToolResultStoreError("artifact ended before its recorded size");
                    offset += bytesRead;
                }
                return buffer;
            };
            const head = trimIncompleteUtf8(await readSample(0)).toString("utf8");
            // Sample the actual saved tail, never the end of a prefix buffer.
            const tail = metadata.byteLength > sampleBytes
                ? selectUtf8Range(await readSample(metadata.byteLength - sampleBytes), sampleBytes).content.toString("utf8")
                : "";
            const preview = createPreview(head + tail, this.previewChars);
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
        origin: PersistedBinaryArtifact["origin"];
        data: Buffer;
        mimeType: string;
        artifactId?: string;
        image?: ImageDescriptor;
    }): Promise<PersistedBinaryArtifact> {
        const origin = binaryOriginSchema.parse(input.origin);
        return this.withMutation(async () => {
            const artifactId = input.artifactId ??
                `${this.resultIdFor(origin.kind === "tool" ? origin.toolCallId : origin.inputId)}-binary`;
            const key = getArtifactKey(this.sessionId, artifactId);
            const contentPath = join(this.sessionDir, `${key}.bin`);
            const metadataPath = join(this.sessionDir, `${key}.binary.json`);
            const existing = await this.loadExistingBinary(
                artifactId,
                contentPath,
                metadataPath
            );
            if (existing) {
                if (input.image && JSON.stringify(existing.image) !== JSON.stringify(input.image)) throw new ToolResultStoreError("图片 ID 冲突");
                return existing;
            }
            await this.removePair(contentPath, metadataPath);

            const usage = await this.currentUsage();
            const remainingSessionBytes = Math.max(0, this.maxSessionBytes - usage);
            const allowed = Math.min(this.maxArtifactBytes, remainingSessionBytes);
            if (allowed <= 0) {
                throw new ToolResultStoreError("tool result session quota exceeded");
            }
            if (input.image) {
                const image = imageDescriptorSchema.parse(input.image);
                if (image.byteLength !== input.data.length || image.mimeType !== input.mimeType ||
                    image.sha256 !== createHash("sha256").update(input.data).digest("hex")) throw new ToolResultStoreError("图片内容与元数据不匹配");
                if (input.data.length > allowed) throw new ToolResultStoreError("图片存储额度不足，未截断或提交图片");
            }
            const stored = input.data.subarray(0, allowed);
            const metadata: PersistedBinaryArtifact = {
                artifactId,
                origin,
                path: contentPath,
                byteLength: stored.byteLength,
                originalByteLength: input.data.byteLength,
                complete: stored.byteLength === input.data.byteLength,
                encoding: "binary",
                mimeType: input.mimeType,
                ...(input.image ? {image: input.image} : {}),
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

    async resolveFile(path: string): Promise<PersistedToolResult | null> {
        const target = resolve(path);
        const storagePath = relative(this.projectsRoot, target);
        if (!isAbsolute(storagePath) && !storagePath.startsWith("..") &&
            /(?:^|\/)sessions\/session-[^/]+\/tool-results(?:\/|$)/.test(storagePath) &&
            dirname(target) !== resolve(this.sessionDir)) {
            throw new ToolResultStoreError("无权读取未授权的会话结果文件");
        }
        if (dirname(target) !== resolve(this.sessionDir) || !/^[a-f0-9]{32}\.txt$/.test(basename(target))) return null;
        const metadataPath = target.slice(0, -4) + ".meta.json";
        const info = await lstat(metadataPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TOOL_RESULT_METADATA_BYTES) {
            throw new ToolResultStoreError("invalid tool result metadata file");
        }
        const value: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
        if (!value || typeof value !== "object" || !("resultId" in value) ||
            typeof value.resultId !== "string" || value.resultId.length > 4096 ||
            resolve(this.paths(value.resultId).content) !== target) {
            throw new ToolResultStoreError("tool result path does not match metadata");
        }
        const result = await this.loadExisting(value.resultId);
        if (!result || result.byteLength > this.maxArtifactBytes) throw new ToolResultStoreError("invalid tool result file");
        return result;
    }

    private async resolveBinaryReference(path: string): Promise<PersistedBinaryArtifact> {
        const resolved = resolve(path);
        if (dirname(resolved) !== resolve(this.sessionDir) || !/^[a-f0-9]{32}\.bin$/.test(basename(resolved))) {
            throw new ToolResultStoreError("无权复制其他 Session 的二进制结果");
        }
        const metadataPath = resolved.slice(0, -4) + ".binary.json";
        const handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > MAX_TOOL_RESULT_METADATA_BYTES) throw new ToolResultStoreError("二进制结果元数据无效");
            const content = Buffer.alloc(info.size);
            const {bytesRead} = await handle.read(content, 0, content.length, 0);
            if (bytesRead !== content.length) throw new ToolResultStoreError("二进制结果元数据不完整");
            const value: unknown = JSON.parse(content.toString("utf8"));
            if (!value || typeof value !== "object" || !("artifactId" in value) || typeof value.artifactId !== "string" ||
                value.artifactId.length > 4096 || basename(resolved) !== `${getArtifactKey(this.sessionId, value.artifactId)}.bin`) {
                throw new ToolResultStoreError("二进制结果路径与元数据不匹配");
            }
            const result = parseBinaryArtifactMetadata(content.toString("utf8"), value.artifactId);
            if (!result || result.byteLength > this.maxArtifactBytes) throw new ToolResultStoreError("二进制结果元数据无效");
            return {...result, path: resolved};
        } finally {await handle.close();}
    }

    async copyReferenceTo(path: string, target: ToolResultStore): Promise<PersistedToolResult | PersistedBinaryArtifact> {
        await this.ensureDir();
        const result = path.endsWith(".bin") ? await this.resolveBinaryReference(path) : await this.resolveFile(path);
        if (!result) throw new ToolResultStoreError("对话引用不是本 Session 的结果");
        const handle = await open(result.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.size !== result.byteLength || before.size > this.maxArtifactBytes) throw new ToolResultStoreError("结果在复制前发生变化");
            const bytes = Buffer.alloc(before.size);
            let offset = 0;
            while (offset < bytes.length) {
                const read = await handle.read(bytes, offset, bytes.length - offset, offset);
                if (!read.bytesRead) throw new ToolResultStoreError("结果复制不完整");
                offset += read.bytesRead;
            }
            const after = await handle.stat();
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new ToolResultStoreError("结果在复制期间发生变化");
            if (result.encoding === "binary" && result.image && createHash("sha256").update(bytes).digest("hex") !== result.image.sha256) throw new ToolResultStoreError("图片完整性校验失败");
            return await target.withMutation(async () => {
                if (bytes.length > target.maxArtifactBytes || await target.currentUsage() + bytes.length > target.maxSessionBytes) {
                    throw new ToolResultStoreError("分支存储额度不足，无法完整复制已保存结果");
                }
                const key = getArtifactKey(target.sessionId, result.encoding === "binary" ? result.artifactId : result.resultId);
                const contentPath = join(target.sessionDir, `${key}.${result.encoding === "binary" ? "bin" : "txt"}`);
                const metadataPath = join(target.sessionDir, `${key}.${result.encoding === "binary" ? "binary" : "meta"}.json`);
                for (const path of [contentPath, metadataPath]) {
                    try {await lstat(path);} catch (error) {if (isCode(error, "ENOENT")) continue; throw error;}
                    throw new ToolResultStoreError("分支结果目标已存在");
                }
                const copied = {...result, path: contentPath};
                const tempContent = join(target.sessionDir, `.tmp-${randomUUID()}`);
                const tempMetadata = join(target.sessionDir, `.tmp-${randomUUID()}`);
                try {
                    await writeFile(tempContent, bytes, {flag: "wx", mode: 0o600});
                    await writeFile(tempMetadata, JSON.stringify(copied), {flag: "wx", mode: 0o600});
                    await target.publishPair(tempContent, tempMetadata, contentPath, metadataPath);
                    return copied;
                } finally {
                    await rm(tempContent, {force: true});
                    await rm(tempMetadata, {force: true});
                }
            });
        } finally {await handle.close();}
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

    imagePath(imageId: string): string {
        if (!/^image-[a-f0-9]{64}$/.test(imageId)) throw new ToolResultStoreError("图片 ID 无效");
        return join(this.sessionDir, `${getArtifactKey(this.sessionId, imageId)}.bin`);
    }

    /** Caller must supply a reference reachable from its own active History/archive. */
    async readImage(reference: ImageReference): Promise<Buffer> {
        imageReferenceSchema.parse(reference);
        const path = this.imagePath(reference.imageId);
        const raw = readPrivateStorageTextFile(this.storage, path.slice(0, -4) + ".binary.json", MAX_TOOL_RESULT_METADATA_BYTES);
        const metadata = raw ? parseBinaryArtifactMetadata(raw, reference.imageId) : null;
        if (!metadata?.image || JSON.stringify(metadata.image) !== JSON.stringify(reference.image)) throw new ToolResultStoreError("图片引用与存储不一致");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const content = Buffer.alloc(reference.image.byteLength);
        try {
            const before = await handle.stat({bigint: true});
            if (!before.isFile() || before.size !== BigInt(content.length)) throw new ToolResultStoreError("图片文件类型或大小无效");
            let offset = 0;
            while (offset < content.length) {
                const {bytesRead} = await handle.read(content, offset, content.length - offset, offset);
                if (!bytesRead) throw new ToolResultStoreError("图片内容不完整");
                offset += bytesRead;
            }
            const after = await handle.stat({bigint: true});
            if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new ToolResultStoreError("图片在读取期间发生变化");
        } finally {await handle.close();}
        if (content.length !== reference.image.byteLength || createHash("sha256").update(content).digest("hex") !== reference.image.sha256) throw new ToolResultStoreError("图片缺失或完整性校验失败");
        return content;
    }

    async removeArtifact(resultId: string): Promise<void> {
        const paths = this.paths(resultId);
        await this.withMutation(() => this.removePair(paths.content, paths.metadata));
    }
}

export const createToolResultStore = ToolResultStore.create;
