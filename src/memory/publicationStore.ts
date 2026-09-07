import {createHash, randomUUID} from "node:crypto";
import {lstat, readdir, unlink} from "node:fs/promises";
import {join} from "node:path";
import {stringify as stringifyYaml} from "yaml";
import {ensurePrivateStorageDirectory, readPrivateStorageTextFile, withFileLock, writeFileAtomically,
    type PillarStorageLayout} from "../persistence/index.js";
import {getMemoryInboxDirectory, getMemoryPublicationPath, getMemoryViewsDirectory, getProjectMemoryDirectory} from "../persistence/layout.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import {memoryDraftTopicSchema, memoryNoteSchema, memoryPublicationSchema, memorySourceRecordSchema,
    type MemoryDraftTopic, type MemoryLease, type MemoryNote, type MemoryPublication, type MemorySourceRecord} from "./publicationSchema.js";
import {memoryKeySchema} from "./schema.js";

const MAX_PUBLICATION_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 5 * 60_000;

function originHash(origin: MemorySourceRecord["origin"]): string {
    return createHash("sha256").update(JSON.stringify(origin)).digest("hex");
}

function emptyPublication(): MemoryPublication {
    return {version: 2, revision: 0, epoch: 0, summary: "", topics: [], sources: [], revoked: []};
}

export function serializeDraftTopic(topic: MemoryDraftTopic): string {
    const {content, ...header} = memoryDraftTopicSchema.parse(topic);
    return `---\n${stringifyYaml(header)}---\n${content}\n`;
}

export function serializeMemoryNote(note: MemoryNote): string {
    const {content, ...header} = memoryNoteSchema.parse(note);
    return `---\n${stringifyYaml(header)}---\n${content}\n`;
}

/** One atomic publication owns topics, pending inputs, revocation and the consumed cursor. */
export class MemoryPublicationStore {
    readonly directory: string;
    private cleanupIssue: string | undefined;
    get viewIssue(): string | undefined {return this.cleanupIssue;}
    constructor(private readonly storage: PillarStorageLayout, cwd: string) {
        this.directory = getProjectMemoryDirectory(storage, cwd);
    }

    snapshot(): MemoryPublication {
        const raw = readPrivateStorageTextFile(this.storage, getMemoryPublicationPath(this.directory), MAX_PUBLICATION_BYTES);
        if (raw === null) return emptyPublication();
        let parsed: unknown;
        try {parsed = JSON.parse(raw);} catch {throw new Error("Memory publication JSON 无效");}
        const result = memoryPublicationSchema.safeParse(parsed);
        if (!result.success) throw new Error("Memory publication 格式或来源引用无效");
        return result.data;
    }

    private async transaction<T>(action: (state: MemoryPublication) => {result: T; changed: boolean}, signal?: AbortSignal): Promise<T> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        return withFileLock(join(this.directory, ".memory.lock"), async () => {
            if (signal) throwIfTurnAborted(signal);
            const state = this.snapshot();
            const {result, changed} = action(state);
            if (!changed) return result;
            state.revision++;
            const encoded = JSON.stringify(memoryPublicationSchema.parse(state));
            if (Buffer.byteLength(encoded) > MAX_PUBLICATION_BYTES) throw new Error("Memory 总量超过 8 MiB，原版本已保留");
            // Validate an existing leaf too: atomic rename must not turn an unsafe target into an allowed write.
            readPrivateStorageTextFile(this.storage, getMemoryPublicationPath(this.directory), MAX_PUBLICATION_BYTES);
            if (signal) throwIfTurnAborted(signal);
            await writeFileAtomically(getMemoryPublicationPath(this.directory), encoded, 0o600);
            return result;
        });
    }

    async acceptNote(key: string, note: MemoryNote, origin: Extract<MemorySourceRecord["origin"], {kind: "explicit"}>, expectedContent: string | null, signal: AbortSignal): Promise<void> {
        memoryKeySchema.parse(key);
        const parsed = memoryNoteSchema.parse(note);
        const source = memorySourceRecordSchema.parse({id: randomUUID(), key, type: parsed.type, content: parsed.content,
            origin, createdAt: new Date().toISOString(), consumed: false});
        await this.transaction(state => {
            if (state.sources.some(item => originHash(item.origin) === originHash(origin))) return {result: undefined, changed: false};
            if (this.noteContent(state, key) !== expectedContent) throw new Error("Memory note 已变化，请重新读取后修改");
            if (parsed.operation === "correct") this.revokeKey(state, key);
            delete state.lease;
            state.sources.push(source);
            delete state.lastIssue;
            return {result: undefined, changed: true};
        }, signal);
        await this.invalidateViews();
    }

    private revokeKey(state: MemoryPublication, key: string): boolean {
        const ids = new Set([...state.sources.filter(source => source.key === key).map(source => source.id),
            ...state.topics.filter(topic => topic.key === key).flatMap(topic => topic.sources)]);
        const affected = state.topics.some(topic => topic.key === key || topic.sources.some(id => ids.has(id))) || ids.size > 0;
        if (!affected) return false;
        state.revoked = [...new Set([...state.revoked, ...state.sources.filter(source => ids.has(source.id)).map(source => originHash(source.origin))])];
        state.sources = state.sources.filter(source => !ids.has(source.id));
        state.topics = state.topics.filter(topic => topic.key !== key && !topic.sources.some(id => ids.has(id)));
        // A summary may paraphrase any forgotten source. Clear it instead of guessing which sentence to remove.
        state.summary = "";
        state.epoch++;
        delete state.lease;
        return affected;
    }

    async forget(key: string, signal: AbortSignal, expected?: {kind: "topic" | "note"; content: string}): Promise<boolean> {
        memoryKeySchema.parse(key);
        const removed = await this.transaction(state => {
            if (expected && (expected.kind === "note" ? this.noteContent(state, key) : this.topicContent(state, key)) !== expected.content) {
                throw new Error("Memory 内容已变化，请重新读取后再忘记");
            }
            const changed = this.revokeKey(state, key);
            return {result: changed, changed};
        }, signal);
        if (removed) await this.invalidateViews();
        return removed;
    }

    async claim(signal: AbortSignal): Promise<{lease: MemoryLease; baseline: MemoryPublication} | undefined> {
        return this.transaction(state => {
            if (state.lease && Date.parse(state.lease.expiresAt) > Date.now()) return {result: undefined, changed: false};
            const pending: string[] = [];
            let bytes = 0;
            for (const source of state.sources.filter(source => !source.consumed)) {
                if (pending.length >= 16 || bytes + Buffer.byteLength(source.content) > 32 * 1024) break;
                pending.push(source.id);
                bytes += Buffer.byteLength(source.content);
            }
            if (!pending.length) return {result: undefined, changed: false};
            state.lease = {id: randomUUID(), revision: state.revision + 1, epoch: state.epoch,
                sourceIds: pending, expiresAt: new Date(Date.now() + LEASE_MS).toISOString()};
            return {result: {lease: structuredClone(state.lease), baseline: structuredClone(state)}, changed: true};
        }, signal);
    }

    async publish(lease: MemoryLease, topics: readonly MemoryDraftTopic[], summary: string, signal: AbortSignal): Promise<void> {
        const drafts = topics.map(topic => memoryDraftTopicSchema.parse(topic));
        if (summary.length > 4000) throw new Error("Memory 摘要超过 4000 字符");
        await this.transaction(state => {
            if (!state.lease || state.lease.id !== lease.id || state.revision !== lease.revision ||
                state.epoch !== lease.epoch || Date.parse(state.lease.expiresAt) <= Date.now()) {
                throw new Error("Memory 整理版本或租约已过期，未发布");
            }
            const allowed = new Set([...state.topics.flatMap(topic => topic.sources), ...lease.sourceIds]);
            if (drafts.some(topic => topic.sources.some(id => !allowed.has(id)))) throw new Error("Memory 草稿引用未提供的来源");
            const represented = new Set(drafts.flatMap(topic => topic.sources));
            if (state.sources.some(source => source.origin.kind === "explicit" && allowed.has(source.id) && !represented.has(source.id))) {
                throw new Error("Memory 草稿遗漏显式 note，未消费或发布");
            }
            const now = new Date().toISOString();
            state.topics = drafts.map(topic => ({...topic,
                createdAt: state.topics.find(old => old.key === topic.key)?.createdAt ?? now, updatedAt: now}));
            state.summary = summary;
            state.sources = state.sources.map(source => lease.sourceIds.includes(source.id) ? {...source, consumed: true} : source);
            delete state.lease;
            delete state.lastIssue;
            return {result: undefined, changed: true};
        }, signal);
        await this.invalidateViews();
    }

    async fail(lease: MemoryLease, reason: string): Promise<void> {
        await this.transaction(state => {
            if (state.lease?.id !== lease.id) return {result: undefined, changed: false};
            delete state.lease;
            state.lastIssue = reason.slice(0, 1000);
            return {result: undefined, changed: true};
        });
    }

    private noteContent(state: MemoryPublication, key: string): string | null {
        const source = state.sources.findLast(source => source.key === key && source.origin.kind === "explicit");
        return source ? serializeMemoryNote({operation: "remember", type: source.type, content: source.content}) : null;
    }

    private topicContent(state: MemoryPublication, key: string): string | null {
        const topic = state.topics.find(topic => topic.key === key);
        return topic ? serializeDraftTopic({key: topic.key, name: topic.name, description: topic.description,
            type: topic.type, content: topic.content, sources: topic.sources}) : null;
    }

    async prepareView(view: {kind: "index"} | {kind: "topic" | "note"; key: string}): Promise<string | null> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        return withFileLock(join(this.directory, ".memory.lock"), async () => {
            const state = this.snapshot();
            const root = view.kind === "note" ? getMemoryInboxDirectory(this.directory) : getMemoryViewsDirectory(this.directory);
            ensurePrivateStorageDirectory(this.storage, root);
            const path = join(root, view.kind === "index" ? "MEMORY.md" : `${memoryKeySchema.parse(view.key)}.md`);
            let content: string | null;
            if (view.kind === "index") {
                content = ["# Pillar Memory", state.summary, ...state.topics.map(topic =>
                    `- ${topic.key} [${topic.type}]: ${topic.description} (${join(root, `${topic.key}.md`)})`)].join("\n") + "\n";
            } else if (view.kind === "note") content = this.noteContent(state, view.key);
            else content = this.topicContent(state, view.key);
            const existing = readPrivateStorageTextFile(this.storage, path, 128 * 1024);
            if (content === null) {
                if (existing !== null) await unlink(path);
                return null;
            }
            if (Buffer.byteLength(content) > 128 * 1024) throw new Error("Memory 读取视图超过 128 KiB");
            if (existing !== content) await writeFileAtomically(path, content, 0o600);
            return path;
        });
    }

    private async invalidateViews(): Promise<void> {
        try {
            await withFileLock(join(this.directory, ".memory.lock"), async () => {
                for (const root of [getMemoryViewsDirectory(this.directory), getMemoryInboxDirectory(this.directory)]) {
                    ensurePrivateStorageDirectory(this.storage, root);
                    await this.clearViewDirectory(root);
                }
            });
            this.cleanupIssue = undefined;
        } catch {
            // Publication already committed. Access checks still consult its current contents before reading a cache.
            this.cleanupIssue = "Memory 已提交；派生缓存清理未完成，读取仍按当前发布版本校验";
        }
    }

    private async clearViewDirectory(root: string): Promise<void> {
        for (const entry of await readdir(root, {withFileTypes: true})) {
            if (!/^(?:MEMORY|[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.test(entry.name)) continue;
            const path = join(root, entry.name);
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error("Memory 读取视图不是普通文件");
            await unlink(path);
        }
    }
}
