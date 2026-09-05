import {randomUUID} from "node:crypto";
import {constants, realpathSync} from "node:fs";
import {chmod, open, readdir, realpath, stat, unlink,} from "node:fs/promises";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {createByteFileChange} from "../fileChanges/index.js";
import {
    ensurePrivateStorageDirectory,
    readPrivateStorageFile,
    readPrivateStorageTextFile,
    type PillarStorageLayout,
    withFileLock,
    writeFileAtomically,
} from "../persistence/index.js";
import {
    fingerprintContent,
    fingerprintFile,
    fingerprintsEqual,
    hashCheckpointContent,
    MAX_CHECKPOINT_FILE_BYTES,
    missingFingerprint,
    resolveCheckpointPath,
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
    type CheckpointSessionLink,
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
const MAX_CHECKPOINT_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CHECKPOINT_WARNINGS = 10_000;
const MAX_CHECKPOINT_ID_CHARACTERS = 512;
const MAX_CHECKPOINT_PATH_CHARACTERS = 16_384;
const MAX_CHECKPOINT_WARNING_CHARACTERS = 8_000;

type StoredCheckpointRecord = Omit<FileCheckpointRecord, "mutations">;

interface BeforeMutationEvent {
    version: 2;
    type: "before";
    root: string;
    path: string;
    before: FileFingerprint;
    beforeBlobId?: string;
    toolCallId: string;
}

interface AfterMutationEvent {
    version: 2;
    type: "after";
    root: string;
    path: string;
    after: FileFingerprint;
    toolCallId: string;
}

type MutationEvent = BeforeMutationEvent | AfterMutationEvent;

function mutationKey(root: string, path: string): string {
    return `${root}\u0000${path}`;
}

function isWithin(root: string, target: string): boolean {
    const candidate = relative(root, target);
    return candidate === "" || (
        candidate !== ".." &&
        !candidate.startsWith(`..${sep}`) &&
        !isAbsolute(candidate)
    );
}

const WARNING_CODES = new Set<CheckpointCoverageWarning["code"]>([
    "bash_side_effects",
    "hook_side_effects",
    "mcp_side_effects",
    "host_tool_side_effects",
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
    if (fingerprint.kind === "missing") {
        return fingerprint.sha256 === undefined &&
            fingerprint.byteLength === undefined &&
            fingerprint.mode === undefined;
    }
    return fingerprint.kind === "regular" &&
        typeof fingerprint.sha256 === "string" &&
        /^[0-9a-f]{64}$/i.test(fingerprint.sha256) &&
        Number.isSafeInteger(fingerprint.byteLength) &&
        (fingerprint.byteLength ?? -1) >= 0 &&
        (fingerprint.byteLength ?? 0) <= MAX_CHECKPOINT_FILE_BYTES &&
        (fingerprint.mode === undefined ||
            (Number.isSafeInteger(fingerprint.mode) && fingerprint.mode >= 0));
}

function isCoverageWarning(value: unknown): value is CheckpointCoverageWarning {
    if (!value || typeof value !== "object") return false;
    const warning = value as Partial<CheckpointCoverageWarning>;
    return typeof warning.code === "string" &&
        WARNING_CODES.has(warning.code as CheckpointCoverageWarning["code"]) &&
        typeof warning.message === "string" &&
        warning.message.length <= MAX_CHECKPOINT_WARNING_CHARACTERS &&
        (warning.path === undefined ||
            (typeof warning.path === "string" &&
                warning.path.length <= MAX_CHECKPOINT_PATH_CHARACTERS));
}

function isIndexEntry(value: unknown): value is FileCheckpointIndexEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<FileCheckpointIndexEntry>;
    return typeof entry.checkpointId === "string" &&
        entry.checkpointId.length > 0 &&
        entry.checkpointId.length <= MAX_CHECKPOINT_ID_CHARACTERS &&
        (entry.parentCheckpointId === undefined ||
            (typeof entry.parentCheckpointId === "string" &&
                entry.parentCheckpointId.length > 0 &&
                entry.parentCheckpointId.length <= MAX_CHECKPOINT_ID_CHARACTERS)) &&
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
        (manifest.sequence ?? -1) < 0 ||
        !manifest.head ||
        typeof manifest.head.branchId !== "string" ||
        manifest.head.branchId.length === 0 ||
        manifest.head.branchId.length > MAX_CHECKPOINT_ID_CHARACTERS ||
        (manifest.head.checkpointId !== undefined &&
            (typeof manifest.head.checkpointId !== "string" ||
                manifest.head.checkpointId.length === 0 ||
                manifest.head.checkpointId.length > MAX_CHECKPOINT_ID_CHARACTERS)) ||
        !Array.isArray(manifest.checkpoints) ||
        manifest.checkpoints.length > MAX_CHECKPOINTS_PER_SESSION ||
        !manifest.checkpoints.every(isIndexEntry)
    ) {
        throw new Error("Checkpoint manifest 格式无效或不属于当前 Session");
    }
    const checkpoints = manifest.checkpoints as FileCheckpointIndexEntry[];
    const ids = new Set<string>();
    let previousSequence = -1;
    for (const checkpoint of checkpoints) {
        if (
            ids.has(checkpoint.checkpointId) ||
            checkpoint.sequence <= previousSequence ||
            checkpoint.sequence > manifest.sequence!
        ) throw new Error("Checkpoint manifest 索引顺序或身份重复");
        ids.add(checkpoint.checkpointId);
        previousSequence = checkpoint.sequence;
    }
    if (manifest.head.checkpointId && !ids.has(manifest.head.checkpointId)) {
        throw new Error("Checkpoint manifest head 不在当前索引中");
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
        record.version !== CHECKPOINT_MANIFEST_VERSION ||
        record.checkpointId !== checkpointId ||
        record.sessionId !== sessionId ||
        typeof record.branchId !== "string" ||
        record.branchId.length === 0 ||
        record.branchId.length > MAX_CHECKPOINT_ID_CHARACTERS ||
        (record.parentCheckpointId !== undefined &&
            (typeof record.parentCheckpointId !== "string" ||
                record.parentCheckpointId.length === 0 ||
                record.parentCheckpointId.length > MAX_CHECKPOINT_ID_CHARACTERS)) ||
        !Number.isSafeInteger(record.sequence) ||
        (record.sequence ?? -1) < 0 ||
        typeof record.createdAt !== "string" ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        typeof record.prompt !== "string" ||
        Buffer.byteLength(record.prompt, "utf8") > MAX_PROMPT_BYTES ||
        typeof record.promptPreview !== "string" ||
        record.promptPreview.length > MAX_PROMPT_PREVIEW_CHARACTERS ||
        !["active", "settled", "no_agent_run", "interrupted"].includes(record.status ?? "") ||
        !["complete", "incomplete"].includes(record.fileCoverage ?? "") ||
        !Array.isArray(record.coverageWarnings) ||
        record.coverageWarnings.length > MAX_CHECKPOINT_WARNINGS ||
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
        event.version !== 2 ||
        typeof event.root !== "string" ||
        event.root.length === 0 ||
        event.root.length > MAX_CHECKPOINT_PATH_CHARACTERS ||
        typeof event.path !== "string" ||
        event.path.length === 0 ||
        event.path.length > MAX_CHECKPOINT_PATH_CHARACTERS ||
        typeof event.toolCallId !== "string" ||
        event.toolCallId.length === 0 ||
        event.toolCallId.length > MAX_CHECKPOINT_ID_CHARACTERS
    ) {
        throw new Error("Checkpoint mutation event 字段无效");
    }
    if (event.type === "before" && isFingerprint(event.before)) {
        const validBlob = event.before.kind === "regular"
            ? event.beforeBlobId === event.before.sha256
            : event.beforeBlobId === undefined;
        if (!validBlob) {
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

export class FileCheckpointStore {
    readonly cwd: string;
    readonly directory: string;
    private readonly manifestPath: string;
    private readonly lockPath: string;
    private readonly pathCwd: string;
    private readonly hardBoundary: string;
    private readonly mutationPathCache = new Map<string, Set<string>>();

    private constructor(
        private readonly storage: PillarStorageLayout,
        cwd: string,
        readonly sessionId: string,
        hardBoundary: string
    ) {
        this.pathCwd = resolve(cwd);
        this.hardBoundary = resolve(hardBoundary);
        try {
            this.cwd = realpathSync.native(cwd).normalize("NFC");
        } catch {
            this.cwd = resolve(cwd).normalize("NFC");
        }
        this.directory = getCheckpointDirectory(
            storage,
            this.cwd,
            sessionId
        );
        this.manifestPath = getCheckpointManifestPath(this.directory);
        this.lockPath = getCheckpointLockPath(this.directory);
    }

    static create(
        storage: PillarStorageLayout,
        cwd: string,
        sessionId: string,
        hardBoundary: string = cwd
    ): FileCheckpointStore {
        return new FileCheckpointStore(storage, cwd, sessionId, hardBoundary);
    }

    private displayPath(root: string, path: string): string {
        return root === this.cwd ? path : resolve(root, path);
    }

    private async validateStoredRoot(root: string): Promise<string> {
        if (!isAbsolute(root)) throw new Error("Checkpoint root 必须是绝对路径");
        const [canonicalBoundary, canonicalRoot, rootInfo] = await Promise.all([
            realpath(this.hardBoundary),
            realpath(root),
            stat(root),
        ]);
        if (!rootInfo.isDirectory()) {
            throw new Error("Checkpoint root 不是目录");
        }
        if (canonicalRoot.normalize("NFC") !== resolve(root).normalize("NFC")) {
            throw new Error("Checkpoint root 已被 symlink 重定向");
        }
        if (!isWithin(canonicalBoundary, canonicalRoot)) {
            throw new Error("Checkpoint root 越过 Host 边界");
        }
        return canonicalRoot;
    }

    private withLock<T>(action: () => Promise<T>): Promise<T> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        return withFileLock(this.lockPath, action);
    }

    private async readManifest(): Promise<FileCheckpointManifest> {
        try {
            const content = readPrivateStorageTextFile(
                this.storage,
                this.manifestPath,
                MAX_CHECKPOINT_MANIFEST_BYTES
            );
            if (content === null) {
                return createEmptyManifest(this.cwd, this.sessionId);
            }
            return parseManifest(
                content,
                this.cwd,
                this.sessionId
            );
        } catch (error) {
            throw new Error(`无法读取 Checkpoint manifest: ${this.manifestPath}`, {
                cause: error,
            });
        }
    }

    private async writeManifest(manifest: FileCheckpointManifest): Promise<void> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        const content = `${JSON.stringify(manifest, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_MANIFEST_BYTES) {
            throw new Error("Checkpoint manifest 超过大小上限");
        }
        await writeFileAtomically(this.manifestPath, content, 0o600);
        await chmod(this.manifestPath, 0o600).catch(() => undefined);
    }

    private async readRecordMetadata(
        checkpointId: string
    ): Promise<StoredCheckpointRecord> {
        const path = getCheckpointRecordPath(this.directory, checkpointId);
        try {
            const content = readPrivateStorageTextFile(
                this.storage,
                path,
                MAX_CHECKPOINT_RECORD_BYTES
            );
            if (content === null) {
                throw new Error(`Checkpoint record 缺失: ${checkpointId}`);
            }
            return parseStoredRecord(
                content,
                checkpointId,
                this.sessionId
            );
        } catch (error) {
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
        ensurePrivateStorageDirectory(this.storage, dirname(path));
        const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_RECORD_BYTES) {
            throw new Error(`Checkpoint record 超过大小上限: ${checkpoint.checkpointId}`);
        }
        await writeFileAtomically(path, content, 0o600);
        await chmod(path, 0o600).catch(() => undefined);
    }

    private async readMutations(
        checkpointId: string
    ): Promise<CheckpointFileMutation[]> {
        const path = getCheckpointMutationLogPath(this.directory, checkpointId);
        const content = readPrivateStorageTextFile(
            this.storage,
            path,
            MAX_CHECKPOINT_MUTATION_LOG_BYTES
        );
        if (content === null) return [];

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
                const key = mutationKey(event.root, event.path);
                if (mutations.has(key)) {
                    throw new Error(`Checkpoint mutation 重复记录 before: ${event.path}`);
                }
                if (mutations.size >= MAX_CHECKPOINT_MUTATIONS) {
                    throw new Error(
                        `Checkpoint mutation 数量超过异常保护上限 ${MAX_CHECKPOINT_MUTATIONS}`
                    );
                }
                mutations.set(key, {
                    root: event.root,
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
            const mutation = mutations.get(mutationKey(event.root, event.path));
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
            (await this.readMutations(checkpointId)).map(
                (mutation) => mutationKey(mutation.root, mutation.path)
            )
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
        ensurePrivateStorageDirectory(this.storage, dirname(path));
        const current = readPrivateStorageFile(
            this.storage,
            path,
            MAX_CHECKPOINT_MUTATION_LOG_BYTES
        );
        const currentBytes = current?.byteLength ?? 0;
        if (
            currentBytes + Buffer.byteLength(line) >
            MAX_CHECKPOINT_MUTATION_LOG_BYTES
        ) {
            throw new Error(
                `Checkpoint mutation log 超过 ${MAX_CHECKPOINT_MUTATION_LOG_BYTES} 字节上限`
            );
        }
        const handle = await open(
            path,
            constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW,
            0o600
        );
        try {
            const metadata = await handle.stat();
            if (!metadata.isFile()) {
                throw new Error(`Checkpoint mutation log 不是 regular file: ${path}`);
            }
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
        await this.withLock(async () => {
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
        ensurePrivateStorageDirectory(this.storage, blobDirectory);
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
        ensurePrivateStorageDirectory(this.storage, dirname(path));
        let replacedBytes = 0;
        const existing = readPrivateStorageFile(
            this.storage,
            path,
            MAX_CHECKPOINT_FILE_BYTES
        );
        if (existing) {
            replacedBytes = existing.byteLength;
            if (hashCheckpointContent(existing) === blobId) return blobId;
        }
        const entries = await readdir(dirname(path), {withFileTypes: true})
            .catch(() => []);
        let totalBytes = 0;
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            totalBytes += (await stat(resolve(dirname(path), entry.name))).size;
        }
        if (
            totalBytes - replacedBytes + Buffer.byteLength(content) >
            MAX_SESSION_BLOB_BYTES
        ) {
            throw new Error(`Session Checkpoint Blob 超过 ${MAX_SESSION_BLOB_BYTES} 字节上限`);
        }
        await writeFileAtomically(
            path,
            Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
            0o600
        );
        await chmod(path, 0o600).catch(() => undefined);
        return blobId;
    }

    private async readVerifiedBlob(blobId: string): Promise<Buffer> {
        const path = getCheckpointBlobPath(this.directory, blobId);
        const content = readPrivateStorageFile(
            this.storage,
            path,
            MAX_CHECKPOINT_FILE_BYTES
        );
        if (content === null) throw new Error(`Checkpoint Blob 缺失: ${blobId}`);
        if (hashCheckpointContent(content) !== blobId) {
            throw new Error(`Checkpoint Blob 校验失败: ${blobId}`);
        }
        return content;
    }

    async getHead(): Promise<CheckpointHead> {
        return {...(await this.readManifest()).head};
    }

    async reconcileSession(expected: CheckpointHead | undefined, links: readonly CheckpointSessionLink[]) {
        return this.withLock(async () => {
            const manifest = await this.readManifest();
            const lineage = activeLineage(manifest);
            if (lineage.length === 0) {
                if (expected?.checkpointId || (manifest.sequence === 0 && links.length)) throw new Error("Session 与 Checkpoint head 无法对账");
                if (manifest.sequence > 0 && expected?.branchId !== manifest.head.branchId) throw new Error("Session 与 Checkpoint branch 不一致");
                return {head: manifest.head, interrupted: []};
            }
            if (expected && expected.branchId !== manifest.head.branchId) throw new Error("Session 与 Checkpoint branch 不一致，拒绝继续写入");
            const anchor = expected?.checkpointId
                ? lineage.findIndex(item => item.checkpointId === expected.checkpointId) : -1;
            if (expected?.checkpointId && anchor < 0 && lineage[0]?.parentCheckpointId !== expected.checkpointId) {
                throw new Error("Session head 不在 Checkpoint 活动 lineage 中");
            }
            const byId = new Map(links.map(link => [link.checkpointId, link]));
            const interrupted: FileCheckpointRecord[] = [];
            for (let n = Math.max(0, anchor); n < lineage.length; n++) {
                const index = lineage[n]!;
                const record = await this.readCheckpointRecord(index.checkpointId);
                if (n === anchor && n < lineage.length - 1 && record.status !== "active") continue;
                const link = byId.get(index.checkpointId);
                if (!link || link.branchId !== record.branchId || link.parentCheckpointId !== record.parentCheckpointId ||
                    record.parentCheckpointId !== index.parentCheckpointId || record.sequence !== index.sequence) {
                    throw new Error(`缺少或不匹配的 Session turn checkpoint: ${index.checkpointId}`);
                }
                if (n > anchor || record.status === "active") interrupted.push({...record, status: "interrupted"});
            }
            for (const record of interrupted) {
                const metadata = await this.readRecordMetadata(record.checkpointId);
                await this.writeRecordMetadata({...metadata, status: "interrupted"});
            }
            return {head: manifest.head, interrupted};
        });
    }

    async retainSessionCheckpoints(ids: readonly string[]): Promise<void> {
        await this.withLock(async () => {
            const manifest = await this.readManifest();
            const retained = new Set(ids);
            const lineage = activeLineage(manifest);
            const first = lineage.findIndex(item => retained.has(item.checkpointId));
            if (first < 0) return;
            const cutoff = lineage[first]!.sequence;
            const removed = manifest.checkpoints.filter(item => item.sequence < cutoff);
            if (!removed.length) return;
            manifest.checkpoints = manifest.checkpoints.filter(item => item.sequence >= cutoff);
            await this.writeManifest(manifest);
            for (const item of removed) {
                this.mutationPathCache.delete(item.checkpointId);
                await unlink(getCheckpointRecordPath(this.directory, item.checkpointId)).catch(() => undefined);
                await unlink(getCheckpointMutationLogPath(this.directory, item.checkpointId)).catch(() => undefined);
            }
            await this.garbageCollectBlobs(manifest).catch(() => undefined);
        });
    }

    async beginCheckpoint(input: BeginCheckpointInput, expectedHead?: CheckpointHead): Promise<FileCheckpointRecord> {
        return this.withLock(async () => {
            const manifest = await this.readManifest();
            if (expectedHead && manifest.sequence > 0 &&
                (expectedHead.checkpointId !== manifest.head.checkpointId || expectedHead.branchId !== manifest.head.branchId)) {
                throw new Error("Checkpoint head 已变化，必须重新恢复 Session 后才能继续写入");
            }
            // Session byte retention can prune through another Store instance between Turns.
            const retainedIds = new Set(manifest.checkpoints.map(item => item.checkpointId));
            for (const id of this.mutationPathCache.keys()) {
                if (!retainedIds.has(id)) this.mutationPathCache.delete(id);
            }
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
                version: CHECKPOINT_MANIFEST_VERSION,
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
            checkpoint.fileCoverage = "incomplete";
        });
    }

    async captureBefore(
        checkpointId: string,
        input: CaptureBeforeWriteInput
    ): Promise<void> {
        const validated = await resolveCheckpointPath(
            this.pathCwd,
            this.hardBoundary,
            input.path
        );
        if (input.content !== null) {
            const bytes = Buffer.byteLength(input.content, "utf8");
            if (bytes > MAX_CHECKPOINT_FILE_BYTES) {
                throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} 字节上限`);
            }
        }
        await this.withLock(async () => {
            findCheckpointIndex(await this.readManifest(), checkpointId);
            const paths = await this.getMutationPaths(checkpointId);
            const key = mutationKey(validated.root, validated.relativePath);
            if (paths.has(key)) return;
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
                version: 2,
                type: "before",
                root: validated.root,
                path: validated.relativePath,
                before,
                ...(beforeBlobId ? {beforeBlobId} : {}),
                toolCallId: input.toolCallId,
            });
            paths.add(key);
        });
    }

    async captureAfter(
        checkpointId: string,
        input: CaptureAfterWriteInput
    ): Promise<void> {
        const validated = await resolveCheckpointPath(
            this.pathCwd,
            this.hardBoundary,
            input.path
        );
        const bytes = input.content === null
            ? 0
            : Buffer.byteLength(input.content, "utf8");
        if (bytes > MAX_CHECKPOINT_FILE_BYTES) {
            throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} 字节上限`);
        }
        const after = input.content === null
            ? missingFingerprint()
            : fingerprintContent(input.content, validated.mode);
        await this.withLock(async () => {
            findCheckpointIndex(await this.readManifest(), checkpointId);
            const paths = await this.getMutationPaths(checkpointId);
            if (!paths.has(mutationKey(validated.root, validated.relativePath))) {
                throw new Error("写入前 Preimage 未成功提交");
            }
            await this.appendMutationEvent(checkpointId, {
                version: 2,
                type: "after",
                root: validated.root,
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
                const key = mutationKey(mutation.root, mutation.path);
                const existing = grouped.get(key);
                if (existing) existing.last = mutation;
                else grouped.set(key, {first: mutation, last: mutation});
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
        for (const {first, last} of grouped.values()) {
            const displayPath = this.displayPath(first.root, first.path);
            try {
                const root = await this.validateStoredRoot(first.root);
                const validated = await validateCheckpointPath(
                    root,
                    resolve(root, first.path)
                );
                const actual = await fingerprintFile(validated.absolutePath);
                const expectedCurrent = last.after!;
                const target = first.before;
                if (
                    !fingerprintsEqual(actual.fingerprint, expectedCurrent) &&
                    !fingerprintsEqual(actual.fingerprint, target)
                ) {
                    conflicts.push({
                        path: displayPath,
                        reason: "external_change",
                        message: "文件内容与 Pillar 最后一次已知写入不一致",
                    });
                    continue;
                }

                let targetContent: Buffer | undefined;
                if (target.kind === "regular") {
                    if (!first.beforeBlobId) {
                        conflicts.push({
                            path: displayPath,
                            reason: "missing_blob",
                            message: "Checkpoint 缺少文件正文引用",
                        });
                        continue;
                    }
                    try {
                        targetContent = await this.readVerifiedBlob(first.beforeBlobId);
                    } catch (error) {
                        conflicts.push({
                            path: displayPath,
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

                const change = action === "noop"
                    ? undefined
                    : createByteFileChange({
                        path: displayPath,
                        kind: action,
                        oldContent: actual.content ?? Buffer.alloc(0),
                        newContent: targetContent ?? Buffer.alloc(0),
                    });
                files.push({
                    root,
                    relativePath: first.path,
                    path: displayPath,
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
                    path: displayPath,
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
        await writeFileAtomically(path, content, fingerprint.mode);
        if (fingerprint.mode !== undefined) {
            await chmod(path, fingerprint.mode).catch(() => undefined);
        }
    }

    async restoreCode(checkpointId: string): Promise<CheckpointRestoreResult> {
        return this.withLock(async () => {
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
                const absolutePath = resolve(file.root, file.relativePath);
                const actual = await fingerprintFile(absolutePath);
                const blobId = actual.content
                    ? await this.ensureBlob(actual.content)
                    : undefined;
                rollback.set(mutationKey(file.root, file.relativePath), {
                    fingerprint: actual.fingerprint,
                    ...(blobId ? {blobId} : {}),
                });
            }

            const applied: CheckpointRestoreFile[] = [];
            const deletedFiles: string[] = [];
            let applyingPath = "<restore>";
            try {
                for (const file of plan.files) {
                    if (file.action === "noop") continue;
                    applyingPath = file.path;
                    await this.applyFingerprint(
                        resolve(file.root, file.relativePath),
                        file.target,
                        file.targetBlobId
                    );
                    applied.push(file);
                    if (file.action === "delete") deletedFiles.push(file.path);
                }
            } catch (error) {
                const failures = [{
                    path: applyingPath,
                    message: error instanceof Error ? error.message : String(error),
                }];
                let rollbackFailed = false;
                for (const file of [...applied].reverse()) {
                    const original = rollback.get(
                        mutationKey(file.root, file.relativePath)
                    )!;
                    try {
                        await this.applyFingerprint(
                            resolve(file.root, file.relativePath),
                            original.fingerprint,
                            original.blobId
                        );
                    } catch (rollbackError) {
                        rollbackFailed = true;
                        failures.push({
                            path: file.path,
                            message: `回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                        });
                    }
                }
                return {
                    status: rollbackFailed ? "partial" : "failed",
                    checkpointId,
                    restoredFiles: rollbackFailed
                        ? applied.map((file) => file.path)
                        : [],
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
                restoredFiles: applied.map((file) => file.path),
                deletedFiles,
                conflicts: [],
                failures: [],
                coverageWarnings: plan.coverageWarnings,
            };
        });
    }
}

export const createFileCheckpointStore = FileCheckpointStore.create;
