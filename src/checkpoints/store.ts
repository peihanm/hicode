import {randomUUID} from "node:crypto";
import {realpathSync} from "node:fs";
import {chmod, mkdir, open, readdir, readFile, stat, unlink,} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {createFileChange} from "../fileChanges/index.js";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import {
    fingerprintContent,
    fingerprintFile,
    fingerprintsEqual,
    hashCheckpointContent,
    MAX_CHECKPOINT_FILE_BYTES,
    missingFingerprint,
    validateCheckpointPath,
} from "./fingerprint.js";
import {
    getCheckpointBlobPath,
    getCheckpointDirectory,
    getCheckpointLockPath,
    getCheckpointManifestPath,
    getCheckpointMutationLogPath,
    getCheckpointRecordPath,
} from "./paths.js";
import {
    type BeginCheckpointInput,
    type CaptureAfterWriteInput,
    type CaptureBeforeWriteInput,
    CHECKPOINT_MANIFEST_VERSION,
    type CheckpointCoverageWarning,
    type CheckpointFileMutation,
    type CheckpointHead,
    type CheckpointRestoreFile,
    type CheckpointRestorePlan,
    type CheckpointRestoreResult,
    type FileCheckpointIndexEntry,
    type FileCheckpointManifest,
    type FileCheckpointRecord,
    type FileFingerprint,
} from "./types.js";

const MAX_CHECKPOINTS_PER_SESSION = 100;
const MAX_CHECKPOINT_MUTATIONS = 100_000;
const MAX_CHECKPOINT_MUTATION_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_PROMPT_PREVIEW_CHARACTERS = 200;
const MAX_SESSION_BLOB_BYTES = 256 * 1024 * 1024;

type StoredCheckpointRecord = Omit<FileCheckpointRecord, "mutations">;

interface BeforeMutationEvent {
    version: 1;
    type: "before";
    path: string;
    before: FileFingerprint;
    beforeBlobId?: string;
    toolCallId: string;
}

interface AfterMutationEvent {
    version: 1;
    type: "after";
    path: string;
    after: FileFingerprint;
    toolCallId: string;
}

type MutationEvent = BeforeMutationEvent | AfterMutationEvent;

const WARNING_CODES = new Set<CheckpointCoverageWarning["code"]>([
    "bash_side_effects",
    "hook_side_effects",
    "mcp_side_effects",
    "unsupported_path",
    "unsupported_file",
    "file_too_large",
    "checkpoint_write_failed",
    "checkpoint_after_write_failed",
]);

function isErrorCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as {code?: string}).code === code
    );
}

function boundedPrompt(prompt: string): string {
    if (Buffer.byteLength(prompt, "utf8") <= MAX_PROMPT_BYTES) return prompt;
    return Buffer.from(prompt, "utf8")
        .subarray(0, MAX_PROMPT_BYTES)
        .toString("utf8");
}

function promptPreview(prompt: string): string {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    return normalized.length <= MAX_PROMPT_PREVIEW_CHARACTERS
        ? normalized
        : `${normalized.slice(0, MAX_PROMPT_PREVIEW_CHARACTERS - 1)}…`;
}

function isFingerprint(value: unknown): value is FileFingerprint {
    if (!value || typeof value !== "object") return false;
    const fingerprint = value as Partial<FileFingerprint>;
    if (fingerprint.kind === "missing") return true;
    return fingerprint.kind === "regular" &&
        typeof fingerprint.sha256 === "string" &&
        typeof fingerprint.byteLength === "number" &&
        (fingerprint.mode === undefined || typeof fingerprint.mode === "number");
}

function isCoverageWarning(value: unknown): value is CheckpointCoverageWarning {
    if (!value || typeof value !== "object") return false;
    const warning = value as Partial<CheckpointCoverageWarning>;
    return typeof warning.code === "string" &&
        WARNING_CODES.has(warning.code as CheckpointCoverageWarning["code"]) &&
        typeof warning.message === "string" &&
        (warning.path === undefined || typeof warning.path === "string");
}

function isIndexEntry(value: unknown): value is FileCheckpointIndexEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<FileCheckpointIndexEntry>;
    return typeof entry.checkpointId === "string" &&
        entry.checkpointId.length > 0 &&
        (entry.parentCheckpointId === undefined ||
            typeof entry.parentCheckpointId === "string") &&
        Number.isSafeInteger(entry.sequence) &&
        (entry.sequence ?? 0) >= 0;
}

function createEmptyManifest(cwd: string, sessionId: string): FileCheckpointManifest {
    return {
        version: CHECKPOINT_MANIFEST_VERSION,
        cwd,
        sessionId,
        sequence: 0,
        head: {branchId: randomUUID()},
        checkpoints: [],
    };
}

function parseManifest(
    content: string,
    cwd: string,
    sessionId: string
): FileCheckpointManifest {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Checkpoint manifest 格式无效");
    }
    const manifest = parsed as Partial<FileCheckpointManifest>;
    if (
        manifest.version !== CHECKPOINT_MANIFEST_VERSION ||
        manifest.cwd !== cwd ||
        manifest.sessionId !== sessionId ||
        !Number.isSafeInteger(manifest.sequence) ||
        !manifest.head ||
        typeof manifest.head.branchId !== "string" ||
        (manifest.head.checkpointId !== undefined &&
            typeof manifest.head.checkpointId !== "string") ||
        !Array.isArray(manifest.checkpoints) ||
        !manifest.checkpoints.every(isIndexEntry)
    ) {
        throw new Error("Checkpoint manifest 格式无效或不属于当前 Session");
    }
    return manifest as FileCheckpointManifest;
}

function parseStoredRecord(
    content: string,
    checkpointId: string,
    sessionId: string
): StoredCheckpointRecord {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`Checkpoint record 格式无效: ${checkpointId}`);
    }
    const record = parsed as Partial<StoredCheckpointRecord>;
    if (
        record.version !== 2 ||
        record.checkpointId !== checkpointId ||
        record.sessionId !== sessionId ||
        typeof record.branchId !== "string" ||
        (record.parentCheckpointId !== undefined &&
            typeof record.parentCheckpointId !== "string") ||
        !Number.isSafeInteger(record.sequence) ||
        typeof record.createdAt !== "string" ||
        typeof record.prompt !== "string" ||
        typeof record.promptPreview !== "string" ||
        !["active", "settled", "no_agent_run"].includes(record.status ?? "") ||
        !["complete", "incomplete"].includes(record.fileCoverage ?? "") ||
        !Array.isArray(record.coverageWarnings) ||
        !record.coverageWarnings.every(isCoverageWarning)
    ) {
        throw new Error(`Checkpoint record 格式无效: ${checkpointId}`);
    }
    return record as StoredCheckpointRecord;
}

function parseMutationEvent(value: unknown): MutationEvent {
    if (!value || typeof value !== "object") {
        throw new Error("Checkpoint mutation event 不是对象");
    }
    const event = value as Partial<MutationEvent>;
    if (
        event.version !== 1 ||
        typeof event.path !== "string" ||
        event.path.length === 0 ||
        typeof event.toolCallId !== "string"
    ) {
        throw new Error("Checkpoint mutation event 字段无效");
    }
    if (event.type === "before" && isFingerprint(event.before)) {
        if (
            event.beforeBlobId !== undefined &&
            typeof event.beforeBlobId !== "string"
        ) {
            throw new Error("Checkpoint mutation Blob 引用无效");
        }
        return event as BeforeMutationEvent;
    }
    if (event.type === "after" && isFingerprint(event.after)) {
        return event as AfterMutationEvent;
    }
    throw new Error("Checkpoint mutation event 类型无效");
}

function findCheckpointIndex(
    manifest: FileCheckpointManifest,
    checkpointId: string
): FileCheckpointIndexEntry {
    const checkpoint = manifest.checkpoints.find(
        (item) => item.checkpointId === checkpointId
    );
    if (!checkpoint) throw new Error(`找不到 Checkpoint: ${checkpointId}`);
    return checkpoint;
}

function activeLineage(
    manifest: FileCheckpointManifest
): FileCheckpointIndexEntry[] {
    const byId = new Map(
        manifest.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint])
    );
    const reversed: FileCheckpointIndexEntry[] = [];
    const visited = new Set<string>();
    let currentId = manifest.head.checkpointId;
    while (currentId) {
        if (visited.has(currentId)) {
            throw new Error("Checkpoint lineage 包含循环引用");
        }
        visited.add(currentId);
        const checkpoint = byId.get(currentId);
        if (!checkpoint) break;
        reversed.push(checkpoint);
        currentId = checkpoint.parentCheckpointId;
    }
    return reversed.reverse();
}

function restoreLineage(
    manifest: FileCheckpointManifest,
    checkpointId: string
): FileCheckpointIndexEntry[] {
    const lineage = activeLineage(manifest);
    const index = lineage.findIndex(
        (checkpoint) => checkpoint.checkpointId === checkpointId
    );
    if (index === -1) {
        throw new Error("目标 Checkpoint 不在当前活动分支中");
    }
    return lineage.slice(index);
}

function uniqueWarnings(
    checkpoints: FileCheckpointRecord[]
): CheckpointCoverageWarning[] {
    const seen = new Set<string>();
    const warnings: CheckpointCoverageWarning[] = [];
    for (const checkpoint of checkpoints) {
        for (const warning of checkpoint.coverageWarnings) {
            const key = `${warning.code}\u0000${warning.path ?? ""}\u0000${warning.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            warnings.push(warning);
        }
    }
    return warnings;
}

function isCaptureFailure(warning: CheckpointCoverageWarning): boolean {
    return warning.code === "checkpoint_write_failed" ||
        warning.code === "checkpoint_after_write_failed" ||
        warning.code === "unsupported_path" ||
        warning.code === "unsupported_file" ||
        warning.code === "file_too_large";
}

export class FileCheckpointStore {
    readonly cwd: string;
    readonly directory: string;
    private readonly manifestPath: string;
    private readonly lockPath: string;
    private readonly pathCwd: string;
    private readonly mutationPathCache = new Map<string, Set<string>>();

    private constructor(
        cwd: string,
        readonly sessionId: string,
        options: FileCheckpointStoreOptions = {}
    ) {
        this.pathCwd = resolve(cwd);
        try {
            this.cwd = realpathSync.native(cwd).normalize("NFC");
        } catch {
            this.cwd = resolve(cwd).normalize("NFC");
        }
        this.directory = getCheckpointDirectory(
            this.cwd,
            sessionId,
            options.projectsRoot
        );
        this.manifestPath = getCheckpointManifestPath(this.directory);
        this.lockPath = getCheckpointLockPath(this.directory);
    }

    static create(cwd: string, sessionId: string): FileCheckpointStore {
        return new FileCheckpointStore(cwd, sessionId);
    }

    static createFactory(options: FileCheckpointStoreOptions = {}) {
        return (cwd: string, sessionId: string): FileCheckpointStore =>
            new FileCheckpointStore(cwd, sessionId, options);
    }

    private async readManifest(): Promise<FileCheckpointManifest> {
        try {
            return parseManifest(
                await readFile(this.manifestPath, "utf8"),
                this.cwd,
                this.sessionId
            );
        } catch (error) {
            if (isErrorCode(error, "ENOENT")) {
                return createEmptyManifest(this.cwd, this.sessionId);
            }
            throw new Error(`无法读取 Checkpoint manifest: ${this.manifestPath}`, {
                cause: error,
            });
        }
    }

    private async writeManifest(manifest: FileCheckpointManifest): Promise<void> {
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        await chmod(this.directory, 0o700).catch(() => undefined);
        await writeFileAtomically(
            this.manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
            0o600
        );
        await chmod(this.manifestPath, 0o600).catch(() => undefined);
    }

    private async readRecordMetadata(
        checkpointId: string
    ): Promise<StoredCheckpointRecord> {
        const path = getCheckpointRecordPath(this.directory, checkpointId);
        try {
            return parseStoredRecord(
                await readFile(path, "utf8"),
                checkpointId,
                this.sessionId
            );
        } catch (error) {
            if (isErrorCode(error, "ENOENT")) {
                throw new Error(`Checkpoint record 缺失: ${checkpointId}`);
            }
            throw error;
        }
    }

    private async writeRecordMetadata(
        checkpoint: StoredCheckpointRecord
    ): Promise<void> {
        const path = getCheckpointRecordPath(
            this.directory,
            checkpoint.checkpointId
        );
        await mkdir(dirname(path), {recursive: true, mode: 0o700});
        await writeFileAtomically(
            path,
            `${JSON.stringify(checkpoint, null, 2)}\n`,
            0o600
        );
        await chmod(path, 0o600).catch(() => undefined);
    }

    private async readMutations(
        checkpointId: string
    ): Promise<CheckpointFileMutation[]> {
        const path = getCheckpointMutationLogPath(this.directory, checkpointId);
        let content: string;
        try {
            const info = await stat(path);
            if (info.size > MAX_CHECKPOINT_MUTATION_LOG_BYTES) {
                throw new Error(
                    `Checkpoint mutation log 超过 ${MAX_CHECKPOINT_MUTATION_LOG_BYTES} 字节上限`
                );
            }
            content = await readFile(path, "utf8");
        } catch (error) {
            if (isErrorCode(error, "ENOENT")) return [];
            throw error;
        }

        const mutations = new Map<string, CheckpointFileMutation>();
        for (const line of content.split("\n")) {
            if (!line) continue;
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                throw new Error(`Checkpoint mutation log 损坏: ${checkpointId}`);
            }
            const event = parseMutationEvent(value);
            if (event.type === "before") {
                if (mutations.has(event.path)) {
                    throw new Error(`Checkpoint mutation 重复记录 before: ${event.path}`);
                }
                if (mutations.size >= MAX_CHECKPOINT_MUTATIONS) {
                    throw new Error(
                        `Checkpoint mutation 数量超过异常保护上限 ${MAX_CHECKPOINT_MUTATIONS}`
                    );
                }
                mutations.set(event.path, {
                    path: event.path,
                    before: event.before,
                    ...(event.beforeBlobId
                        ? {beforeBlobId: event.beforeBlobId}
                        : {}),
                    firstToolCallId: event.toolCallId,
                    lastToolCallId: event.toolCallId,
                });
                continue;
            }
            const mutation = mutations.get(event.path);
            if (!mutation) {
                throw new Error(`Checkpoint mutation 缺少 before: ${event.path}`);
            }
            mutation.after = event.after;
            mutation.lastToolCallId = event.toolCallId;
        }
        return [...mutations.values()];
    }

    private async readCheckpointRecord(
        checkpointId: string
    ): Promise<FileCheckpointRecord> {
        const [metadata, mutations] = await Promise.all([
            this.readRecordMetadata(checkpointId),
            this.readMutations(checkpointId),
        ]);
        const unfinished = mutations.filter((mutation) => !mutation.after);
        if (unfinished.length === 0) return {...metadata, mutations};
        const warning: CheckpointCoverageWarning = {
            code: "checkpoint_after_write_failed",
            message: `有 ${unfinished.length} 个文件缺少写入后指纹`,
        };
        return {
            ...metadata,
            fileCoverage: "incomplete",
            coverageWarnings: [...metadata.coverageWarnings, warning],
            mutations,
        };
    }

    private async getMutationPaths(checkpointId: string): Promise<Set<string>> {
        const cached = this.mutationPathCache.get(checkpointId);
        if (cached) return cached;
        const paths = new Set(
            (await this.readMutations(checkpointId)).map((mutation) => mutation.path)
        );
        this.mutationPathCache.set(checkpointId, paths);
        return paths;
    }

    private async appendMutationEvent(
        checkpointId: string,
        event: MutationEvent
    ): Promise<void> {
        const path = getCheckpointMutationLogPath(this.directory, checkpointId);
        const line = `${JSON.stringify(event)}\n`;
        const currentBytes = await stat(path)
            .then((info) => info.size)
            .catch((error) => {
                if (isErrorCode(error, "ENOENT")) return 0;
                throw error;
            });
        if (
            currentBytes + Buffer.byteLength(line) >
            MAX_CHECKPOINT_MUTATION_LOG_BYTES
        ) {
            throw new Error(
                `Checkpoint mutation log 超过 ${MAX_CHECKPOINT_MUTATION_LOG_BYTES} 字节上限`
            );
        }
        await mkdir(dirname(path), {recursive: true, mode: 0o700});
        const handle = await open(path, "a", 0o600);
        try {
            await handle.appendFile(line, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await chmod(path, 0o600).catch(() => undefined);
    }

    private async mutateRecord(
        checkpointId: string,
        action: (checkpoint: StoredCheckpointRecord) => void
    ): Promise<void> {
        await withFileLock(this.lockPath, async () => {
            findCheckpointIndex(await this.readManifest(), checkpointId);
            const checkpoint = await this.readRecordMetadata(checkpointId);
            action(checkpoint);
            await this.writeRecordMetadata(checkpoint);
        });
    }

    private async garbageCollectBlobs(
        manifest: FileCheckpointManifest
    ): Promise<void> {
        const referenced = new Set<string>();
        for (const checkpoint of manifest.checkpoints) {
            for (const mutation of await this.readMutations(checkpoint.checkpointId)) {
                if (mutation.beforeBlobId) referenced.add(mutation.beforeBlobId);
            }
        }
        const blobDirectory = resolve(this.directory, "blobs");
        const entries = await readdir(blobDirectory, {withFileTypes: true})
            .catch((error) => {
                if (isErrorCode(error, "ENOENT")) return [];
                throw error;
            });
        for (const entry of entries) {
            if (!entry.isFile() || referenced.has(entry.name)) continue;
            await unlink(resolve(blobDirectory, entry.name)).catch((error) => {
                if (!isErrorCode(error, "ENOENT")) throw error;
            });
        }
    }

    private async ensureBlob(content: string | Buffer): Promise<string> {
        const blobId = hashCheckpointContent(content);
        const path = getCheckpointBlobPath(this.directory, blobId);
        try {
            await stat(path);
            return blobId;
        } catch (error) {
            if (!isErrorCode(error, "ENOENT")) throw error;
        }
        await mkdir(dirname(path), {recursive: true, mode: 0o700});
        const entries = await readdir(dirname(path), {withFileTypes: true})
            .catch(() => []);
        let totalBytes = 0;
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            totalBytes += (await stat(resolve(dirname(path), entry.name))).size;
        }
        if (totalBytes + Buffer.byteLength(content) > MAX_SESSION_BLOB_BYTES) {
            throw new Error(`Session Checkpoint Blob 超过 ${MAX_SESSION_BLOB_BYTES} 字节上限`);
        }
        await writeFileAtomically(
            path,
            Buffer.isBuffer(content) ? content.toString("utf8") : content,
            0o600
        );
        await chmod(path, 0o600).catch(() => undefined);
        return blobId;
    }

    private async readVerifiedBlob(blobId: string): Promise<Buffer> {
        const path = getCheckpointBlobPath(this.directory, blobId);
        let content: Buffer;
        try {
            content = await readFile(path);
        } catch (error) {
            if (isErrorCode(error, "ENOENT")) {
                throw new Error(`Checkpoint Blob 缺失: ${blobId}`);
            }
            throw error;
        }
        if (hashCheckpointContent(content) !== blobId) {
            throw new Error(`Checkpoint Blob 校验失败: ${blobId}`);
        }
        return content;
    }

    async getHead(): Promise<CheckpointHead> {
        return {...(await this.readManifest()).head};
    }

    async beginCheckpoint(input: BeginCheckpointInput): Promise<FileCheckpointRecord> {
        return withFileLock(this.lockPath, async () => {
            const manifest = await this.readManifest();
            const checkpointId = input.checkpointId ?? randomUUID();
            if (manifest.checkpoints.some((item) => item.checkpointId === checkpointId)) {
                throw new Error(`Checkpoint 已存在: ${checkpointId}`);
            }
            const branchId = input.branchId ?? manifest.head.branchId;
            const parentCheckpointId =
                input.parentCheckpointId ?? manifest.head.checkpointId;
            if (parentCheckpointId) {
                findCheckpointIndex(manifest, parentCheckpointId);
            }
            manifest.sequence += 1;
            const checkpoint: FileCheckpointRecord = {
                version: 2,
                checkpointId,
                sessionId: this.sessionId,
                branchId,
                ...(parentCheckpointId ? {parentCheckpointId} : {}),
                sequence: manifest.sequence,
                createdAt: new Date().toISOString(),
                prompt: boundedPrompt(input.prompt),
                promptPreview: promptPreview(input.prompt),
                status: "active",
                fileCoverage: "complete",
                coverageWarnings: [],
                mutations: [],
            };
            const {mutations: _mutations, ...metadata} = checkpoint;
            await this.writeRecordMetadata(metadata);
            manifest.checkpoints.push({
                checkpointId,
                ...(parentCheckpointId ? {parentCheckpointId} : {}),
                sequence: checkpoint.sequence,
            });
            const removed = manifest.checkpoints.length > MAX_CHECKPOINTS_PER_SESSION
                ? manifest.checkpoints.splice(
                    0,
                    manifest.checkpoints.length - MAX_CHECKPOINTS_PER_SESSION
                )
                : [];
            manifest.head = {branchId, checkpointId};
            await this.writeManifest(manifest);
            for (const item of removed) {
                this.mutationPathCache.delete(item.checkpointId);
                await unlink(getCheckpointRecordPath(
                    this.directory,
                    item.checkpointId
                )).catch(() => undefined);
                await unlink(getCheckpointMutationLogPath(
                    this.directory,
                    item.checkpointId
                )).catch(() => undefined);
            }
            // Metadata 已提交；清理失败留待下一次淘汰重试。
            await this.garbageCollectBlobs(manifest).catch(() => undefined);
            return checkpoint;
        });
    }

    async settleCheckpoint(
        checkpointId: string,
        status: FileCheckpointRecord["status"]
    ): Promise<void> {
        await this.mutateRecord(checkpointId, (checkpoint) => {
            checkpoint.status = status;
        });
    }

    async addWarning(
        checkpointId: string,
        warning: CheckpointCoverageWarning
    ): Promise<void> {
        await this.mutateRecord(checkpointId, (checkpoint) => {
            const duplicate = checkpoint.coverageWarnings.some(
                (item) =>
                    item.code === warning.code &&
                    item.path === warning.path &&
                    item.message === warning.message
            );
            if (!duplicate) checkpoint.coverageWarnings.push(warning);
            if (isCaptureFailure(warning)) {
                checkpoint.fileCoverage = "incomplete";
            }
        });
    }

    async captureBefore(
        checkpointId: string,
        input: CaptureBeforeWriteInput
    ): Promise<void> {
        const validated = await validateCheckpointPath(this.pathCwd, input.path);
        if (input.content !== null) {
            const bytes = Buffer.byteLength(input.content, "utf8");
            if (bytes > MAX_CHECKPOINT_FILE_BYTES) {
                throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} 字节上限`);
            }
        }
        await withFileLock(this.lockPath, async () => {
            findCheckpointIndex(await this.readManifest(), checkpointId);
            const paths = await this.getMutationPaths(checkpointId);
            if (paths.has(validated.relativePath)) return;
            if (paths.size >= MAX_CHECKPOINT_MUTATIONS) {
                throw new Error(
                    `Checkpoint mutation 数量超过异常保护上限 ${MAX_CHECKPOINT_MUTATIONS}`
                );
            }
            const before = input.content === null
                ? missingFingerprint()
                : fingerprintContent(input.content, validated.mode);
            const beforeBlobId = input.content === null
                ? undefined
                : await this.ensureBlob(input.content);
            await this.appendMutationEvent(checkpointId, {
                version: 1,
                type: "before",
                path: validated.relativePath,
                before,
                ...(beforeBlobId ? {beforeBlobId} : {}),
                toolCallId: input.toolCallId,
            });
            paths.add(validated.relativePath);
        });
    }

    async captureAfter(
        checkpointId: string,
        input: CaptureAfterWriteInput
    ): Promise<void> {
        const validated = await validateCheckpointPath(this.pathCwd, input.path);
        const bytes = input.content === null
            ? 0
            : Buffer.byteLength(input.content, "utf8");
        if (bytes > MAX_CHECKPOINT_FILE_BYTES) {
            throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} 字节上限`);
        }
        const after = input.content === null
            ? missingFingerprint()
            : fingerprintContent(input.content, validated.mode);
        await withFileLock(this.lockPath, async () => {
            findCheckpointIndex(await this.readManifest(), checkpointId);
            const paths = await this.getMutationPaths(checkpointId);
            if (!paths.has(validated.relativePath)) {
                throw new Error("写入前 Preimage 未成功提交");
            }
            await this.appendMutationEvent(checkpointId, {
                version: 1,
                type: "after",
                path: validated.relativePath,
                after,
                toolCallId: input.toolCallId,
            });
        });
    }

    async listCheckpoints(): Promise<FileCheckpointRecord[]> {
        const manifest = await this.readManifest();
        const lineage = activeLineage(manifest);
        return (await Promise.all(
            lineage.map((item) => this.readCheckpointRecord(item.checkpointId))
        )).reverse();
    }

    private async buildRestorePlan(
        manifest: FileCheckpointManifest,
        checkpointId: string
    ): Promise<CheckpointRestorePlan> {
        const indexes = restoreLineage(manifest, checkpointId);
        const lineage = await Promise.all(
            indexes.map((item) => this.readCheckpointRecord(item.checkpointId))
        );
        const grouped = new Map<
            string,
            {first: CheckpointFileMutation; last: CheckpointFileMutation}
        >();
        for (const checkpoint of lineage) {
            for (const mutation of checkpoint.mutations) {
                if (!mutation.after) continue;
                const existing = grouped.get(mutation.path);
                if (existing) existing.last = mutation;
                else grouped.set(mutation.path, {first: mutation, last: mutation});
            }
        }

        const files: CheckpointRestoreFile[] = [];
        const conflicts: CheckpointRestorePlan["conflicts"] = lineage
            .filter((checkpoint) => checkpoint.fileCoverage === "incomplete")
            .map((checkpoint) => ({
                path: `<checkpoint:${checkpoint.checkpointId}>`,
                reason: "incomplete_checkpoint" as const,
                message: `任务“${checkpoint.promptPreview}”存在未捕获的文件写入，无法保证完整恢复`,
            }));
        for (const [relativePath, {first, last}] of grouped) {
            const absolutePath = resolve(this.cwd, relativePath);
            try {
                const validated = await validateCheckpointPath(this.cwd, absolutePath);
                const actual = await fingerprintFile(validated.absolutePath);
                const expectedCurrent = last.after!;
                const target = first.before;
                if (
                    !fingerprintsEqual(actual.fingerprint, expectedCurrent) &&
                    !fingerprintsEqual(actual.fingerprint, target)
                ) {
                    conflicts.push({
                        path: relativePath,
                        reason: "external_change",
                        message: "文件内容与 Pillar 最后一次已知写入不一致",
                    });
                    continue;
                }

                let targetContent: Buffer | undefined;
                if (target.kind === "regular") {
                    if (!first.beforeBlobId) {
                        conflicts.push({
                            path: relativePath,
                            reason: "missing_blob",
                            message: "Checkpoint 缺少文件正文引用",
                        });
                        continue;
                    }
                    try {
                        targetContent = await this.readVerifiedBlob(first.beforeBlobId);
                    } catch (error) {
                        conflicts.push({
                            path: relativePath,
                            reason: error instanceof Error && error.message.includes("校验失败")
                                ? "corrupt_blob"
                                : "missing_blob",
                            message: error instanceof Error ? error.message : String(error),
                        });
                        continue;
                    }
                }

                let action: CheckpointRestoreFile["action"];
                if (fingerprintsEqual(actual.fingerprint, target)) action = "noop";
                else if (target.kind === "missing") action = "delete";
                else if (actual.fingerprint.kind === "missing") action = "create";
                else action = "update";

                const actualText = actual.content?.toString("utf8") ?? "";
                const targetText = targetContent?.toString("utf8") ?? "";
                const change = action === "noop"
                    ? undefined
                    : createFileChange({
                        path: relativePath,
                        kind: action === "create" ? "create" : "update",
                        oldContent: actualText,
                        newContent: targetText,
                    });
                files.push({
                    path: relativePath,
                    action,
                    target,
                    ...(first.beforeBlobId
                        ? {targetBlobId: first.beforeBlobId}
                        : {}),
                    expectedCurrent,
                    actualCurrent: actual.fingerprint,
                    ...(change ? {change} : {}),
                });
            } catch (error) {
                conflicts.push({
                    path: relativePath,
                    reason: "unsupported_path",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return {
            checkpointId,
            files,
            conflicts,
            coverageWarnings: uniqueWarnings(lineage),
        };
    }

    async previewRestore(checkpointId: string): Promise<CheckpointRestorePlan> {
        return this.buildRestorePlan(await this.readManifest(), checkpointId);
    }

    private async applyFingerprint(
        path: string,
        fingerprint: FileFingerprint,
        blobId?: string
    ): Promise<void> {
        if (fingerprint.kind === "missing") {
            try {
                await unlink(path);
            } catch (error) {
                if (!isErrorCode(error, "ENOENT")) throw error;
            }
            return;
        }
        if (!blobId) throw new Error("恢复 regular file 时缺少 Blob");
        const content = await this.readVerifiedBlob(blobId);
        await writeFileAtomically(path, content.toString("utf8"), fingerprint.mode);
        if (fingerprint.mode !== undefined) {
            await chmod(path, fingerprint.mode).catch(() => undefined);
        }
    }

    async restoreCode(checkpointId: string): Promise<CheckpointRestoreResult> {
        return withFileLock(this.lockPath, async () => {
            const manifest = await this.readManifest();
            const targetCheckpoint = findCheckpointIndex(manifest, checkpointId);
            const plan = await this.buildRestorePlan(manifest, checkpointId);
            if (plan.conflicts.length > 0) {
                return {
                    status: "conflict",
                    checkpointId,
                    restoredFiles: [],
                    deletedFiles: [],
                    conflicts: plan.conflicts,
                    failures: [],
                    coverageWarnings: plan.coverageWarnings,
                };
            }

            const rollback = new Map<
                string,
                {fingerprint: FileFingerprint; blobId?: string}
            >();
            for (const file of plan.files) {
                if (file.action === "noop") continue;
                const absolutePath = resolve(this.cwd, file.path);
                const actual = await fingerprintFile(absolutePath);
                const blobId = actual.content
                    ? await this.ensureBlob(actual.content)
                    : undefined;
                rollback.set(file.path, {
                    fingerprint: actual.fingerprint,
                    ...(blobId ? {blobId} : {}),
                });
            }

            const applied: string[] = [];
            const deletedFiles: string[] = [];
            let applyingPath = "<restore>";
            try {
                for (const file of plan.files) {
                    if (file.action === "noop") continue;
                    applyingPath = file.path;
                    await this.applyFingerprint(
                        resolve(this.cwd, file.path),
                        file.target,
                        file.targetBlobId
                    );
                    applied.push(file.path);
                    if (file.action === "delete") deletedFiles.push(file.path);
                }
            } catch (error) {
                const failures = [{
                    path: applyingPath,
                    message: error instanceof Error ? error.message : String(error),
                }];
                let rollbackFailed = false;
                for (const path of [...applied].reverse()) {
                    const original = rollback.get(path)!;
                    try {
                        await this.applyFingerprint(
                            resolve(this.cwd, path),
                            original.fingerprint,
                            original.blobId
                        );
                    } catch (rollbackError) {
                        rollbackFailed = true;
                        failures.push({
                            path,
                            message: `回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                        });
                    }
                }
                return {
                    status: rollbackFailed ? "partial" : "failed",
                    checkpointId,
                    restoredFiles: rollbackFailed ? applied : [],
                    deletedFiles: [],
                    conflicts: [],
                    failures,
                    coverageWarnings: plan.coverageWarnings,
                };
            }

            manifest.head = {
                branchId: randomUUID(),
                ...(targetCheckpoint.parentCheckpointId
                    ? {checkpointId: targetCheckpoint.parentCheckpointId}
                    : {}),
            };
            await this.writeManifest(manifest);
            return {
                status: "complete",
                checkpointId,
                restoredFiles: applied,
                deletedFiles,
                conflicts: [],
                failures: [],
                coverageWarnings: plan.coverageWarnings,
            };
        });
    }
}

export interface FileCheckpointStoreOptions {
    projectsRoot?: string;
}

export const createFileCheckpointStore = FileCheckpointStore.create;

export function createFileCheckpointStoreFactory(
    options: FileCheckpointStoreOptions = {}
) {
    return FileCheckpointStore.createFactory(options);
}
