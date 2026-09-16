import { serializeMemoryNote } from "./note.js";
import type { ExtractedMemoryFact } from "./sourceExtractor.js";
import { memoryFrameSchema, type MemoryFrame } from "./publicationSchema.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ensurePrivateStorageDirectory, readPrivateStorageTextFile, withFileLock, writeFileAtomically, type HiCodeStorageLayout } from "../persistence/index.js";
import { getMemoryWorkspacesDirectory, getMemoryWorkspacePaths, getMemoryInboxDirectory, getMemoryPublicationPath, getMemoryViewsDirectory, getProjectMemoryDirectory } from "../persistence/layout.js";
import { throwIfTurnAborted } from "../runtime/abort.js";
import { memoryDraftTopicSchema, memoryNoteSchema, memoryPublicationSchema, memorySourceRecordSchema, type MemoryDraftTopic, type MemoryLease, type MemoryNote, type MemoryPublication, type MemorySourceRecord } from "./publicationSchema.js";
import { memoryKeySchema } from "./schema.js";
const MAX_PUBLICATION_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 5 * 60000;
function originHash(origin: MemorySourceRecord["origin"]): string {
    return createHash("sha256").update(JSON.stringify(origin)).digest("hex");
}
function emptyPublication(): MemoryPublication {
    return { version: 3, revision: 0, epoch: 0, summary: "", topics: [], sources: [], frames: [], completedFrames: [], retiredSources: [], revoked: [] };
}
export function serializeDraftTopic(topic: MemoryDraftTopic): string {
    const { content, ...header } = memoryDraftTopicSchema.parse(topic);
    return `---\n${stringifyYaml(header)}---\n${content}\n`;
}
/** One atomic publication owns topics, pending inputs, revocation and the consumed cursor. */
export class MemoryPublicationStore {
    readonly directory: string;
    private cleanupIssue: string | undefined;
    get viewIssue(): string | undefined { return this.cleanupIssue; }
    constructor(private readonly storage: HiCodeStorageLayout, cwd: string) {
        this.directory = getProjectMemoryDirectory(storage, cwd);
    }
    snapshot(): MemoryPublication {
        const raw = readPrivateStorageTextFile(this.storage, getMemoryPublicationPath(this.directory), MAX_PUBLICATION_BYTES);
        if (raw === null)
            return emptyPublication();
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error("Invalid Memory publication JSON");
        }
        const result = memoryPublicationSchema.safeParse(parsed);
        if (!result.success)
            throw new Error("Invalid Memory publication format or source reference");
        return result.data;
    }
    private async transaction<T>(action: (state: MemoryPublication) => {
        result: T;
        changed: boolean;
    }, signal?: AbortSignal): Promise<T> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        return withFileLock(join(this.directory, ".memory.lock"), async () => {
            if (signal)
                throwIfTurnAborted(signal);
            const state = this.snapshot();
            const { result, changed } = action(state);
            if (!changed)
                return result;
            this.collect(state);
            if (state.frames.length > 1000) throw new Error("Memory pending sources reached 1000; run /memory maintain first");
            if (state.sources.length > 1000) throw new Error("Memory active sources reached 1000; consolidate or forget unneeded topics first");
            if (state.revoked.length > 10000) throw new Error("Memory forget receipts reached 10000; receipts and the original version were preserved");
            state.revision++;
            const encoded = JSON.stringify(memoryPublicationSchema.parse(state));
            if (Buffer.byteLength(encoded) > MAX_PUBLICATION_BYTES)
                throw new Error("Memory exceeds 8 MiB; original version preserved");
            // Validate an existing leaf too: atomic rename must not turn an unsafe target into an allowed write.
            readPrivateStorageTextFile(this.storage, getMemoryPublicationPath(this.directory), MAX_PUBLICATION_BYTES);
            if (signal)
                throwIfTurnAborted(signal);
            await writeFileAtomically(getMemoryPublicationPath(this.directory), encoded, 0o600);
            return result;
        });
    }
    private collect(state: MemoryPublication): void {
        const protectedFrames = new Set(state.lease?.frameIds ?? []);
        const completed = state.frames.filter(frame => frame.status !== "pending" && !protectedFrames.has(frame.id));
        const retained = Math.max(0, Math.min(128, 1000 - (state.frames.length - completed.length)));
        const retired = new Set(completed.slice(0, Math.max(0, completed.length - retained)).map(frame => frame.id));
        state.completedFrames = [...new Set([...state.completedFrames, ...retired])].slice(-4096);
        state.frames = state.frames.filter(frame => !retired.has(frame.id));
        const referenced = new Set([...state.topics.flatMap(topic => topic.sources), ...(state.lease?.sourceIds ?? [])]);
        const removed = state.sources.filter(source => source.consumed && !referenced.has(source.id));
        state.retiredSources = [...new Set([...state.retiredSources, ...removed.map(source => originHash(source.origin))])].slice(-4096);
        // The free-form summary may paraphrase discarded evidence; do not retain untraceable memory.
        if (removed.length) state.summary = "";
        const removedIds = new Set(removed.map(source => source.id));
        state.sources = state.sources.filter(source => !removedIds.has(source.id));
        // Revocations are permanent exclusion evidence, never ordinary eviction candidates.
    }
    async acceptNote(key: string, note: MemoryNote, origin: Extract<MemorySourceRecord["origin"], {
        kind: "explicit";
    }>, expectedContent: string | null, signal: AbortSignal): Promise<void> {
        memoryKeySchema.parse(key);
        const parsed = memoryNoteSchema.parse(note);
        const source = memorySourceRecordSchema.parse({ id: randomUUID(), key, type: parsed.type, content: parsed.content,
            origin, createdAt: new Date().toISOString(), consumed: false });
        await this.transaction(state => {
            if (state.retiredSources.includes(originHash(origin)) || state.sources.some(item => originHash(item.origin) === originHash(origin)))
                return { result: undefined, changed: false };
            if (this.noteContent(state, key) !== expectedContent)
                throw new Error("Memory note changed; read it again before editing");
            if (state.revoked.includes(originHash(origin)))
                throw new Error("Memory source was revoked");
            if (parsed.operation === "correct") {
                if (!this.revokeKey(state, key)) state.epoch++;
                delete state.lease;
            }
            state.sources.push(source);
            delete state.lastIssue;
            return { result: undefined, changed: true };
        }, signal);
        await this.invalidateViews();
    }
    private revokeKey(state: MemoryPublication, key: string): boolean {
        const ids = new Set([...state.sources.filter(source => source.key === key).map(source => source.id),
            ...state.topics.filter(topic => topic.key === key).flatMap(topic => topic.sources)]);
        const affected = state.topics.some(topic => topic.key === key || topic.sources.some(id => ids.has(id))) || ids.size > 0;
        if (!affected)
            return false;
        state.revoked = [...new Set([...state.revoked, ...state.sources.filter(source => ids.has(source.id)).map(source => originHash(source.origin))])];
        state.sources = state.sources.filter(source => !ids.has(source.id));
        state.topics = state.topics.filter(topic => topic.key !== key && !topic.sources.some(id => ids.has(id)));
        // A summary may paraphrase any forgotten source. Clear it instead of guessing which sentence to remove.
        state.summary = "";
        state.epoch++;
        delete state.lease;
        return affected;
    }
    async forget(key: string, signal: AbortSignal, expected?: {
        kind: "topic" | "note";
        content: string;
    }): Promise<boolean> {
        memoryKeySchema.parse(key);
        const removed = await this.transaction(state => {
            if (expected && (expected.kind === "note" ? this.noteContent(state, key) : this.topicContent(state, key)) !== expected.content) {
                throw new Error("Memory content changed; read it again before forgetting");
            }
            const changed = this.revokeKey(state, key);
            return { result: changed, changed };
        }, signal);
        if (removed)
            await this.invalidateViews();
        return removed;
    }
    async offerFrame(frame: Omit<MemoryFrame, "epoch" | "status" | "createdAt">, signal: AbortSignal): Promise<void> {
        await this.transaction(state => {
            if (state.completedFrames.includes(frame.id) || state.frames.some(item => item.id === frame.id))
                return { result: undefined, changed: false };
            state.frames.push(memoryFrameSchema.parse({ ...frame, epoch: state.epoch, status: "pending", createdAt: new Date().toISOString() }));
            return { result: undefined, changed: true };
        }, signal);
    }
    async claimExtraction(signal: AbortSignal): Promise<{
        lease: MemoryLease;
        frames: MemoryFrame[];
    } | undefined> {
        return this.transaction(state => {
            if (state.lease && Date.parse(state.lease.expiresAt) > Date.now())
                return { result: undefined, changed: false };
            let changed = state.lease !== undefined;
            delete state.lease;
            for (const frame of state.frames)
                if (frame.status === "pending" && frame.epoch !== state.epoch) {
                    frame.status = "no_output";
                    changed = true;
                }
            const frames = state.frames.filter(frame => frame.status === "pending").slice(0, 4);
            if (!frames.length)
                return { result: undefined, changed };
            state.lease = { id: randomUUID(), phase: "extract", frameIds: frames.map(frame => frame.id), sourceIds: [], revision: state.revision + 1, epoch: state.epoch, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
            return { result: { lease: structuredClone(state.lease), frames: structuredClone(frames) }, changed: true };
        }, signal);
    }
    private requireLease(state: MemoryPublication, lease: MemoryLease, phase: MemoryLease["phase"]): void {
        const current = state.lease;
        if (!current || current.id !== lease.id || current.phase !== phase || lease.phase !== phase || state.epoch !== lease.epoch ||
            current.revision !== lease.revision || current.epoch !== lease.epoch || current.expiresAt !== lease.expiresAt || Date.parse(current.expiresAt) <= Date.now() ||
            current.sourceIds.join(",") !== lease.sourceIds.join(",") || current.frameIds.join(",") !== lease.frameIds.join(",")) {
            throw new Error("Memory version/lease expired or the source set changed; nothing was published");
        }
    }
    async finishExtraction(lease: MemoryLease, results: readonly {
        frame: MemoryFrame;
        facts: readonly ExtractedMemoryFact[];
        unavailable: boolean;
    }[], signal: AbortSignal): Promise<void> {
        await this.transaction(state => {
            this.requireLease(state, lease, "extract");
            if (results.length !== lease.frameIds.length || new Set(results.map(result => result.frame.id)).size !== results.length || results.some(result => !lease.frameIds.includes(result.frame.id)))
                throw new Error("Memory extraction consumption set does not match");
            for (const { frame, facts, unavailable } of results) {
                if (unavailable && facts.length)
                    throw new Error("Inaccessible sources cannot produce facts");
                const current = state.frames.find(item => item.id === frame.id)!;
                if (JSON.stringify(current) !== JSON.stringify(frame))
                    throw new Error("Memory frame changed");
                if (facts.length > 8)
                    throw new Error("Too many Memory facts");
                for (const fact of facts) {
                    if (fact.sources.some(hash => !frame.messageHashes.includes(hash)))
                        throw new Error("Memory fact reference is out of bounds");
                    const source = memorySourceRecordSchema.parse({ id: randomUUID(), key: fact.key, type: fact.type, content: fact.content, consumed: false, createdAt: new Date().toISOString(),
                        origin: { kind: "session", sessionId: frame.sessionId, messageHashes: fact.sources, contentHash: frame.id, basis: fact.basis } });
                    if (!state.revoked.includes(originHash(source.origin)) && !state.retiredSources.includes(originHash(source.origin)) &&
                        !state.sources.some(existing => existing.key === source.key && existing.content === source.content && originHash(existing.origin) === originHash(source.origin)))
                        state.sources.push(source);
                }
                current.status = unavailable ? "unavailable" : facts.length ? "extracted" : "no_output";
            }
            delete state.lease;
            delete state.lastIssue;
            if (results.some(result => result.unavailable))
                state.lastIssue = "Some session sources are inaccessible; they were skipped without generating facts. Other notes can still be consolidated.";
            return { result: undefined, changed: true };
        }, signal);
        await this.invalidateViews();
    }
    async claim(signal: AbortSignal): Promise<{
        lease: MemoryLease;
        baseline: MemoryPublication;
    } | undefined> {
        return this.transaction(state => {
            if (state.lease && Date.parse(state.lease.expiresAt) > Date.now())
                return { result: undefined, changed: false };
            const changed = state.lease !== undefined;
            delete state.lease;
            const pending: string[] = [];
            let bytes = 0;
            for (const source of state.sources.filter(source => !source.consumed)) {
                if (pending.length >= 16 || bytes + Buffer.byteLength(source.content) > 32 * 1024)
                    break;
                pending.push(source.id);
                bytes += Buffer.byteLength(source.content);
            }
            if (!pending.length)
                return { result: undefined, changed };
            state.lease = { id: randomUUID(), phase: "consolidate", frameIds: [], revision: state.revision + 1, epoch: state.epoch,
                sourceIds: pending, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
            return { result: { lease: structuredClone(state.lease), baseline: structuredClone(state) }, changed: true };
        }, signal);
    }
    async publish(lease: MemoryLease, topics: readonly MemoryDraftTopic[], summary: string, signal: AbortSignal): Promise<void> {
        const drafts = topics.map(topic => memoryDraftTopicSchema.parse(topic));
        if (summary.length > 4000)
            throw new Error("Memory summary exceeds 4000 characters");
        await this.transaction(state => {
            this.requireLease(state, lease, "consolidate");
            const allowed = new Set([...state.topics.flatMap(topic => topic.sources), ...lease.sourceIds]);
            if (drafts.some(topic => topic.sources.some(id => !allowed.has(id))))
                throw new Error("Memory draft cites an unavailable source");
            const represented = new Set(drafts.flatMap(topic => topic.sources));
            if (state.sources.some(source => source.origin.kind === "explicit" && allowed.has(source.id) && !represented.has(source.id))) {
                throw new Error("Memory draft omitted an explicit note; nothing was consumed or published");
            }
            const now = new Date().toISOString();
            state.topics = drafts.map(topic => ({ ...topic,
                createdAt: state.topics.find(old => old.key === topic.key)?.createdAt ?? now, updatedAt: now }));
            state.summary = summary;
            state.sources = state.sources.map(source => lease.sourceIds.includes(source.id) ? { ...source, consumed: true } : source);
            delete state.lease;
            delete state.lastIssue;
            return { result: undefined, changed: true };
        }, signal);
        await this.invalidateViews();
    }
    async fail(lease: MemoryLease, reason: string): Promise<void> {
        await this.transaction(state => {
            if (state.lease?.id !== lease.id)
                return { result: undefined, changed: false };
            delete state.lease;
            state.lastIssue = reason.slice(0, 1000);
            return { result: undefined, changed: true };
        });
    }
    private noteContent(state: MemoryPublication, key: string): string | null {
        const source = state.sources.findLast(source => source.key === key && source.origin.kind === "explicit");
        return source ? serializeMemoryNote({ operation: "remember", type: source.type, content: source.content }) : null;
    }
    private topicContent(state: MemoryPublication, key: string): string | null {
        const topic = state.topics.find(topic => topic.key === key);
        const pending = state.sources.findLast(source => source.key === key && !source.consumed && source.origin.kind === "session");
        const view = pending ? { key, name: key, description: "Automatically extracted; pending consolidation", type: pending.type, content: pending.content, sources: [pending.id] } : topic;
        if (!view)
            return null;
        const evidence = state.sources.filter(source => view.sources.includes(source.id)).map(source => ({ id: source.id, ...source.origin }));
        return serializeDraftTopic({ key: view.key, name: view.name, description: view.description, type: view.type, content: view.content, sources: view.sources }) +
            `\n## Sources (historical data, not execution authorization)\n ${JSON.stringify(evidence).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}\n`;
    }
    async prepareView(view: {
        kind: "index";
    } | {
        kind: "topic" | "note";
        key: string;
    }): Promise<string | null> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        return withFileLock(join(this.directory, ".memory.lock"), async () => {
            const state = this.snapshot();
            const root = view.kind === "note" ? getMemoryInboxDirectory(this.directory) : getMemoryViewsDirectory(this.directory);
            ensurePrivateStorageDirectory(this.storage, root);
            const path = join(root, view.kind === "index" ? "MEMORY.md" : `${memoryKeySchema.parse(view.key)}.md`);
            let content: string | null;
            if (view.kind === "index") {
                const lines = ["# HiCode Memory", state.summary, ...state.topics.map(topic => `- ${topic.key} [${topic.type}]: ${topic.description} (${join(root, `${topic.key}.md`)})`),
                    ...state.sources.filter(source => !source.consumed).slice(-200).map(source => `- ${source.key} [pending ${source.origin.kind}]: ${join(source.origin.kind === "explicit" ? getMemoryInboxDirectory(this.directory) : root, `${source.key}.md`)}`)];
                const selected: string[] = [];
                let bytes = 0;
                for (const line of lines) {
                    const cost = Buffer.byteLength(line) + 1;
                    if (bytes + cost > 120 * 1024)
                        break;
                    selected.push(line);
                    bytes += cost;
                }
                content = selected.join("\n") + "\n" + (selected.length < lines.length ? `Index budget omitted ${lines.length - selected.length} lines; use /memory list to view entries.\n` : "");
            }
            else if (view.kind === "note")
                content = this.noteContent(state, view.key);
            else
                content = this.topicContent(state, view.key);
            const existing = readPrivateStorageTextFile(this.storage, path, 128 * 1024);
            if (content === null) {
                if (existing !== null)
                    await unlink(path);
                return null;
            }
            if (Buffer.byteLength(content) > 128 * 1024)
                throw new Error("Memory read view exceeds 128 KiB");
            if (existing !== content)
                await writeFileAtomically(path, content, 0o600);
            return path;
        });
    }
    async recoverWorkspaces(signal: AbortSignal): Promise<void> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        await withFileLock(join(this.directory, ".memory.lock"), async () => {
            throwIfTurnAborted(signal);
            const state = this.snapshot();
            const root = getMemoryWorkspacesDirectory(this.directory);
            ensurePrivateStorageDirectory(this.storage, root);
            const entries = await readdir(root, { withFileTypes: true });
            if (entries.length > 1000)
                throw new Error("Unexpected number of Memory workspaces");
            for (const entry of entries) {
                if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name))
                    continue;
                if (state.lease?.id === entry.name && Date.parse(state.lease.expiresAt) > Date.now())
                    continue;
                if (!entry.isDirectory() || entry.isSymbolicLink())
                    throw new Error("Memory workspace is not a regular directory");
                const paths = getMemoryWorkspacePaths(this.directory, entry.name);
                ensurePrivateStorageDirectory(this.storage, paths.root);
                throwIfTurnAborted(signal);
                await rm(paths.root, { recursive: true, force: true });
            }
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
        }
        catch {
            // Publication already committed. Access checks still consult its current contents before reading a cache.
            this.cleanupIssue = "Memory committed; derived-cache cleanup is incomplete. Reads still validate against the current publication.";
        }
    }
    private async clearViewDirectory(root: string): Promise<void> {
        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!/^(?:MEMORY|[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.test(entry.name))
                continue;
            const path = join(root, entry.name);
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error("Memory read view is not a regular file");
            await unlink(path);
        }
    }
}
