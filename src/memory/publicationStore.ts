import {parseMemoryTopic, serializeMemoryTopic} from "./topic.js";
import {readdirSync, lstatSync} from "node:fs";
import {prepareFileCommit} from "../tools/shared/fileCommit.js";
import {realpath} from "node:fs/promises";
import type { ExtractedMemoryFact } from "./sourceExtractor.js";
import { memoryFrameSchema, type MemoryFrame } from "./publicationSchema.js";
import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ensurePrivateStorageDirectory, readPrivateStorageTextFile, withFileLock, writeFileAtomically, type HiCodeStorageLayout } from "../persistence/index.js";
import { getMemoryWorkspacesDirectory, getMemoryWorkspacePaths, getMemoryStatePath, getMemoryIndexPath, getMemoryTopicsDirectory, getProjectMemoryDirectory } from "../persistence/layout.js";
import { throwIfTurnAborted } from "../runtime/abort.js";
import { memoryDraftTopicSchema, memoryPublicationSchema, memoryStateSchema, memorySourceRecordSchema, type MemoryDraftTopic, type MemoryLease, type MemoryPublication, type MemorySourceRecord } from "./publicationSchema.js";
import { memoryKeySchema } from "./schema.js";
const MAX_PUBLICATION_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 5 * 60000;
function originHash(origin: MemorySourceRecord["origin"]): string {
    return createHash("sha256").update(JSON.stringify(origin)).digest("hex");
}
function emptyPublication(): MemoryPublication {
    return { version: 4, revision: 0, epoch: 0, topics: [], sources: [], frames: [], completedFrames: [], retiredSources: [], revoked: [] };
}
export function serializeDraftTopic(topic: MemoryDraftTopic): string {
    const { content, ...header } = memoryDraftTopicSchema.parse(topic);
    return `---\n${stringifyYaml(header)}---\n${content}\n`;
}
/** Markdown owns content; the locked workflow stores provenance, leases and bounded receipts. */
export class MemoryPublicationStore {
    readonly directory: string;
    constructor(private readonly storage: HiCodeStorageLayout, cwd: string) {
        this.directory = getProjectMemoryDirectory(storage, cwd);
    }
    private readState() {
        const raw = readPrivateStorageTextFile(this.storage, getMemoryStatePath(this.directory), MAX_PUBLICATION_BYTES);
        if (raw === null) return memoryStateSchema.parse(emptyPublication());
        try { return memoryStateSchema.parse(JSON.parse(raw)); }
        catch { throw new Error("Invalid Memory workflow state; original files were preserved"); }
    }
    private scanFiles(): Map<string, {raw: string; hash: string; topic: ReturnType<typeof parseMemoryTopic>; date: string}> {
        const root = getMemoryTopicsDirectory(this.directory);
        const files = new Map<string, {raw: string; hash: string; topic: ReturnType<typeof parseMemoryTopic>; date: string}>();
        // Validate the directory even when it is empty; aliases never grant access.
        try {
            const stat = lstatSync(root);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Memory topics must be a regular directory");
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return files;
            throw error;
        }
        const entries = readdirSync(root, {withFileTypes: true});
        const topics = entries.filter(entry => entry.name.endsWith(".md"));
        if (topics.length > 200) throw new Error("Memory topics exceed 200");
        for (const entry of topics) {
            const key = memoryKeySchema.parse(entry.name.slice(0, -3));
            const path = join(root, entry.name);
            const raw = readPrivateStorageTextFile(this.storage, path, 40 * 1024);
            if (raw === null) throw new Error("Memory changed while scanning; retry");
            files.set(key, {raw, hash: createHash("sha256").update(raw).digest("hex"), topic: parseMemoryTopic(raw, key), date: lstatSync(path).mtime.toISOString()});
        }
        return files;
    }
    private filesHash(): string {
        return createHash("sha256").update(JSON.stringify([...this.scanFiles()].map(([key, file]) => [key, file.hash]).sort((a,b) => a[0]!.localeCompare(b[0]!)))).digest("hex");
    }
    snapshot(): MemoryPublication {
        const saved = this.readState();
        const files = this.scanFiles();
        const changed = new Set([...saved.topics.filter(topic => files.get(topic.key)?.hash !== topic.hash).map(topic => topic.key),
            ...[...files.keys()].filter(key => !saved.topics.some(topic => topic.key === key))]);
        const revokedIds = new Set(saved.topics.filter(topic => changed.has(topic.key)).flatMap(topic => topic.sources));
        // Once file publication starts, an interrupted batch is never replayed into files.
        // This favors preserving human deletions over reconstructing an ambiguous partial commit.
        const publishing = saved.lease?.publishing === true;
        const interrupted = publishing && Date.parse(saved.lease!.expiresAt) <= Date.now();
        const attempted = new Set(interrupted ? saved.lease!.sourceIds : []);
        const discarded = publishing && !interrupted ? [] : saved.sources.filter(source => changed.has(source.key) || revokedIds.has(source.id) || attempted.has(source.id));
        const state: MemoryPublication = {...saved, topics: [], sources: saved.sources.filter(source => !discarded.includes(source))};
        if ((!publishing && changed.size) || interrupted) {
            if (interrupted) state.lastIssue = "Memory publication was interrupted. Completed file edits remain; this source batch will not be replayed. Inspect topic files before continuing.";
            state.epoch++;
            delete state.lease;
            state.revoked = [...new Set([...state.revoked, ...discarded.map(source => originHash(source.origin))])];
            for (const frame of state.frames) if (frame.status === "pending") frame.status = "no_output";
        }
        const ids = new Set(state.sources.map(source => source.id));
        state.topics = [...files].map(([key, file]) => {
            const old = saved.topics.find(topic => topic.key === key);
            return {key, ...file.topic, sources: changed.has(key) ? [] : (old?.sources ?? []).filter(id => ids.has(id)),
                createdAt: old?.createdAt ?? file.date, updatedAt: changed.has(key) ? file.date : old?.updatedAt ?? file.date};
        });
        return memoryPublicationSchema.parse(state);
    }
    private async saveState(state: MemoryPublication): Promise<void> {
        this.collect(state);
        const files = this.scanFiles();
        if (files.size !== state.topics.length || state.topics.some(topic => {
            const actual = files.get(topic.key)?.topic;
            return !actual || actual.content !== topic.content || actual.name !== topic.name || actual.description !== topic.description || actual.type !== topic.type;
        })) throw new Error("Memory files changed before workflow commit; external changes were preserved");
        const {topics, ...workflow} = memoryPublicationSchema.parse(state);
        const data = memoryStateSchema.parse({...workflow, topics: topics.filter(topic => files.has(topic.key)).map(topic => ({
            key: topic.key, hash: files.get(topic.key)!.hash, sources: topic.sources, createdAt: topic.createdAt, updatedAt: topic.updatedAt,
        }))});
        const encoded = JSON.stringify(data);
        if (Buffer.byteLength(encoded) > MAX_PUBLICATION_BYTES) throw new Error("Memory workflow exceeds 8 MiB");
        readPrivateStorageTextFile(this.storage, getMemoryStatePath(this.directory), MAX_PUBLICATION_BYTES);
        await writeFileAtomically(getMemoryStatePath(this.directory), encoded, 0o600);
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
            if (!changed && state.epoch === this.readState().epoch)
                return result;
            this.collect(state);
            if (state.frames.length > 1000) throw new Error("Memory pending sources reached 1000; run /memory maintain first");
            if (state.sources.length > 1000) throw new Error("Memory active sources reached 1000; consolidate or forget unneeded topics first");
            if (state.revoked.length > 10000) throw new Error("Memory forget receipts reached 10000; receipts and the original version were preserved");
            state.revision++;
            if (signal) throwIfTurnAborted(signal);
            await this.saveState(state);
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
        const removedIds = new Set(removed.map(source => source.id));
        state.sources = state.sources.filter(source => !removedIds.has(source.id));
        // Revocations are permanent exclusion evidence, never ordinary eviction candidates.
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
            state.lease = { id: randomUUID(), filesHash: this.filesHash(), phase: "extract", frameIds: frames.map(frame => frame.id), sourceIds: [], revision: state.revision + 1, epoch: state.epoch, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
            return { result: { lease: structuredClone(state.lease), frames: structuredClone(frames) }, changed: true };
        }, signal);
    }
    private requireLease(state: MemoryPublication, lease: MemoryLease, phase: MemoryLease["phase"]): void {
        const current = state.lease;
        if (!current || current.id !== lease.id || current.phase !== phase || lease.phase !== phase || state.epoch !== lease.epoch ||
            current.filesHash !== lease.filesHash || lease.filesHash !== this.filesHash() || current.revision !== lease.revision || current.epoch !== lease.epoch || current.expiresAt !== lease.expiresAt || Date.parse(current.expiresAt) <= Date.now() ||
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
            state.lease = { id: randomUUID(), filesHash: this.filesHash(), phase: "consolidate", frameIds: [], revision: state.revision + 1, epoch: state.epoch,
                sourceIds: pending, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
            return { result: { lease: structuredClone(state.lease), baseline: structuredClone(state) }, changed: true };
        }, signal);
    }
    async publish(lease: MemoryLease, topics: readonly MemoryDraftTopic[], signal: AbortSignal): Promise<void> {
        const drafts = topics.map(topic => memoryDraftTopicSchema.parse(topic));
        if (drafts.length > 200 || new Set(drafts.map(topic => topic.key)).size !== drafts.length) throw new Error("Invalid Memory draft topic set");
        ensurePrivateStorageDirectory(this.storage, this.directory);
        await withFileLock(join(this.directory, ".memory.lock"), async () => {
            const state = this.snapshot();
            this.requireLease(state, lease, "consolidate");
            const allowed = new Set([...state.topics.flatMap(topic => topic.sources), ...lease.sourceIds]);
            if (drafts.some(topic => topic.sources.some(id => !allowed.has(id)))) throw new Error("Memory draft cites an unavailable source");
            // Human-authored files cannot be silently dropped by an automatic consolidation.
            if (state.topics.some(topic => !topic.sources.length && !drafts.some(draft => draft.key === topic.key))) throw new Error("Memory draft omitted a manually maintained topic");
            const files = this.scanFiles();
            const root = getMemoryTopicsDirectory(this.directory);
            ensurePrivateStorageDirectory(this.storage, root);
            const keys = new Set([...files.keys(), ...drafts.map(topic => topic.key)]);
            throwIfTurnAborted(signal);
            state.lease!.publishing = true;
            await this.saveState(state);
            for (const key of keys) {
                throwIfTurnAborted(signal);
                // Recheck the whole baseline between commits; never overwrite a concurrent editor.
                const current = this.scanFiles();
                if (current.size !== files.size || [...files].some(([name, file]) => current.get(name)?.hash !== file.hash)) throw new Error("Memory files changed during publication; completed file edits remain, external edits were preserved");
                const draft = drafts.find(topic => topic.key === key);
                const after = draft ? serializeMemoryTopic({name: draft.name, description: draft.description, type: draft.type, content: draft.content}) : null;
                const before = files.get(key)?.raw ?? null;
                if (after === before) continue;
                const path = join(root, `${key}.md`);
                const canonical = join(await realpath(root), `${key}.md`);
                await prepareFileCommit(path, canonical, before, 0o600)(after, signal);
                if (after === null) files.delete(key);
                else files.set(key, {raw: after, hash: createHash("sha256").update(after).digest("hex"), topic: parseMemoryTopic(after, key), date: new Date().toISOString()});
            }
            const now = new Date().toISOString();
            state.topics = drafts.map(topic => ({...topic, createdAt: state.topics.find(old => old.key === topic.key)?.createdAt ?? now, updatedAt: now}));
            state.sources = state.sources.map(source => lease.sourceIds.includes(source.id) ? {...source, consumed: true, content: ""} : source);
            delete state.lease; delete state.lastIssue; state.revision++;
            await this.saveState(state);
        });
    }
    async fail(lease: MemoryLease, reason: string): Promise<void> {
        await this.transaction(state => {
            if (state.lease?.id !== lease.id)
                return { result: undefined, changed: false };
            if (state.lease.publishing) {
                const attempted = state.sources.filter(source => state.lease!.sourceIds.includes(source.id));
                const removed = new Set(attempted.map(source => source.id));
                state.revoked = [...new Set([...state.revoked, ...attempted.map(source => originHash(source.origin))])];
                state.sources = state.sources.filter(source => !removed.has(source.id));
                state.topics = state.topics.map(topic => ({...topic, sources: topic.sources.filter(id => !removed.has(id))}));
                state.epoch++;
                for (const frame of state.frames) if (frame.status === "pending") frame.status = "no_output";
                reason = "Memory file publication failed. Completed edits remain; the attempted source batch will not be replayed. Inspect topic files.";
            }
            delete state.lease;
            state.lastIssue = reason.slice(0, 1000);
            return { result: undefined, changed: true };
        });
    }
    async prepareView(view: {kind: "index"} | {kind: "topic"; key: string}): Promise<string | null> {
        const state = this.snapshot();
        if (view.kind === "topic") return state.topics.some(topic => topic.key === view.key) ? join(getMemoryTopicsDirectory(this.directory), `${memoryKeySchema.parse(view.key)}.md`) : null;
        ensurePrivateStorageDirectory(this.storage, this.directory);
        const path = getMemoryIndexPath(this.directory);
        const lines: string[] = ["# HiCode Memory"];
        let bytes = 0;
        for (const topic of state.topics) {
            const line = `- ${topic.key} [${topic.type}]: ${topic.description} (${join(getMemoryTopicsDirectory(this.directory), `${topic.key}.md`)})`;
            if (bytes + Buffer.byteLength(line) > 120 * 1024) break;
            lines.push(line); bytes += Buffer.byteLength(line) + 1;
        }
        const omitted = state.topics.length - (lines.length - 1);
        if (omitted) lines.push(`Index omitted ${omitted} topics; use /memory list for the complete list.`);
        const content = lines.join("\n") + "\n";
        readPrivateStorageTextFile(this.storage, path, 128 * 1024);
        await writeFileAtomically(path, content, 0o600);
        return path;
    }
    prepareTopicsDirectory(): string {
        const root = getMemoryTopicsDirectory(this.directory);
        ensurePrivateStorageDirectory(this.storage, root);
        return root;
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
}
