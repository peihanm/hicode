import {contentText} from "../images/content.js";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { selectSessionMemorySource, readSessionSourceIds, readSessionSourceMessages, withSessionPersistenceLock } from "../session/snapshotStore.js";
import { ensurePrivateStorageDirectory } from "../persistence/index.js";
import { getMemoryWorkspacePaths } from "../persistence/layout.js";
import { createMemorySourceExtractor, type MemorySourceExtractor } from "./sourceExtractor.js";
import type { AgentRunner } from "../agent/index.js";
import type { ResolvedHiCodeSettings } from "../settings/index.js";
import type { ModelTargetSettings } from "../settings/types.js";
import type { ShellRunnerLike } from "../tools/bash/shellRunner.js";
import type { HiCodeStorageLayout } from "../persistence/index.js";
import { throwIfTurnAborted } from "../runtime/abort.js";
import { getMemoryTopicsDirectory } from "../persistence/layout.js";
import { join } from "node:path";
import { createMemoryConsolidator, type MemoryConsolidator } from "./consolidator.js";
import { createPublicationFileAccess } from "./publicationAccess.js";
import { formatPublicationContext } from "./publicationPrompt.js";
import { MemoryPublicationStore } from "./publicationStore.js";
import type { MemoryChange, MemoryContextResult, MemoryEntry, MemoryFileAccess, MemoryRuntimeStatus, MemoryScanResult } from "./types.js";
// Preserve Chinese opt-out phrases (ignore memory; do not use/read/refer to memory) alongside English.
const SUPPRESS_MEMORY = [/\u5ffd\u7565.{0,8}(?:memory|\u8bb0\u5fc6)/i, /\u4e0d\u8981.{0,8}(?:\u4f7f\u7528|\u8bfb\u53d6|\u53c2\u8003).{0,8}(?:memory|\u8bb0\u5fc6)/i,
    /(?:ignore|do not use|don't use).{0,20}memor/i];
type FileOwner = {sessionId: string; turnId: string; signal: AbortSignal};
interface MemoryMaintenanceResult {
    status: "empty" | "busy" | "published";
    topics: number;
}
export interface MemoryRuntimeLike {
    readonly enabled: boolean;
    readonly autoExtract: boolean;
    readonly directory: string;
    list(): Promise<MemoryScanResult>;
    read(key: string): Promise<MemoryEntry | undefined>;
    status(): Promise<MemoryRuntimeStatus>;
    contextForTurn(userInput: string): Promise<MemoryContextResult>;
    fileAccess(owner: FileOwner): MemoryFileAccess;
    getRevision(): number;
    explicitChangesSince(revision: number, owner: Pick<FileOwner, "sessionId" | "turnId">): MemoryChange[];
    maintain(input: {
        sessionId: string;
        signal: AbortSignal;
    }): Promise<MemoryMaintenanceResult>;
    captureBaseline(sessionId: string, prompt: string): Promise<string[] | undefined>;
    captureSource(sessionId: string, baseline: readonly string[], signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
}
class MemoryRuntime implements MemoryRuntimeLike {
    private notificationRevision = 0;
    private readonly changes: Array<{
        revision: number;
        change: MemoryChange;
        owner: Pick<FileOwner, "sessionId" | "turnId">;
    }> = [];
    private closed = false;
    readonly directory: string;
    constructor(readonly enabled: boolean, readonly autoExtract: boolean, private readonly store: MemoryPublicationStore, private readonly createConsolidator: () => MemoryConsolidator, private readonly storage: HiCodeStorageLayout, private readonly cwd: string, private readonly createExtractor: (storage: HiCodeStorageLayout) => MemorySourceExtractor) { this.directory = store.directory; }
    private requireOpen(): void {
        if (!this.enabled)
            throw new Error("Memory is closed");
        if (this.closed)
            throw new Error("Memory is closed");
    }
    private record(change: MemoryChange, owner: Pick<FileOwner, "sessionId" | "turnId">): MemoryChange {
        this.changes.push({ revision: ++this.notificationRevision, change, owner });
        if (this.changes.length > 100)
            this.changes.shift();
        return change;
    }
    getRevision(): number { return this.notificationRevision; }
    explicitChangesSince(revision: number, owner: Pick<FileOwner, "sessionId" | "turnId">): MemoryChange[] { return this.changes.filter(entry => entry.revision > revision && entry.owner.sessionId === owner.sessionId && entry.owner.turnId === owner.turnId).map(entry => entry.change); }
    async list(): Promise<MemoryScanResult> {
        if (!this.enabled)
            return { entries: [], issues: [] };
        return this.scanSnapshot(this.store.snapshot());
    }
    private scanSnapshot(state: ReturnType<MemoryPublicationStore["snapshot"]>): MemoryScanResult {
        const entries: MemoryEntry[] = state.topics.map(topic => ({ version: 2, key: topic.key, name: topic.name,
            description: topic.description, type: topic.type, source: topic.sources.length === 0 ? "explicit" : "automatic",
            evidence: state.sources.filter(source => topic.sources.includes(source.id)).map(source => source.origin),
            createdAt: topic.createdAt, updatedAt: topic.updatedAt, content: topic.content, path: join(getMemoryTopicsDirectory(this.directory), `${topic.key}.md`) }));
        return { entries, issues: state.lastIssue ? [{path: this.directory, message: state.lastIssue}] : [] };
    }
    async read(key: string): Promise<MemoryEntry | undefined> { return (await this.list()).entries.find(entry => entry.key === key); }

    async status(): Promise<MemoryRuntimeStatus> {
        const state = this.enabled ? this.store.snapshot() : undefined;
        const scan = state ? this.scanSnapshot(state) : {entries: [], issues: []};
        const counts: MemoryRuntimeStatus["counts"] = { user: 0, feedback: 0, project: 0, reference: 0 };
        for (const entry of scan.entries)
            counts[entry.type]++;
        return { enabled: this.enabled, autoExtract: this.enabled && this.autoExtract, directory: this.directory, counts, issues: scan.issues,
            pending: (state?.sources.filter(source => !source.consumed).length ?? 0) + (state?.frames.filter(frame => frame.status === "pending").length ?? 0), published: state?.topics.length ?? 0,
            maintaining: Boolean(state?.lease && Date.parse(state.lease.expiresAt) > Date.now()) };
    }
    async contextForTurn(userInput: string): Promise<MemoryContextResult> {
        if (!this.enabled)
            return { ignoredForTurn: false };
        if (SUPPRESS_MEMORY.some(pattern => pattern.test(userInput)))
            return { ignoredForTurn: true,
                block: "<system-reminder>The user requested no Memory for this turn. Memory file access is restricted: do not read, maintain or apply saved memories.</system-reminder>" };
        try {
            return { ignoredForTurn: false, block: formatPublicationContext(this.directory, this.store.snapshot()) };
        }
        catch {
            return { ignoredForTurn: true, block: "<system-reminder>Memory publication could not be read. Do not read or maintain Memory this turn, or assume saved content exists.</system-reminder>" };
        }
    }
    fileAccess(owner: FileOwner): MemoryFileAccess {
        const access = createPublicationFileAccess(this.store);
        return { ...access,
            prepare: async (path, tool) => { this.requireOpen(); await access.prepare(path, tool); },
            validateWrite: (path, content) => { this.requireOpen(); access.validateWrite(path, content); },
            written: (...args) => this.record(access.written(...args), owner),
            shellDirectory: async path => {this.requireOpen(); return access.shellDirectory(path); } };
    }
    async captureBaseline(sessionId: string, prompt: string): Promise<string[] | undefined> {
        if (!this.enabled || !this.autoExtract || this.closed || SUPPRESS_MEMORY.some(pattern => pattern.test(prompt)))
            return undefined;
        try {
            this.store.snapshot();
            return await withSessionPersistenceLock(this.storage, this.cwd, sessionId, async () => readSessionSourceIds(this.storage, this.cwd, sessionId));
        }
        catch {
            return undefined;
        }
    }
    async captureSource(sessionId: string, baseline: readonly string[], signal: AbortSignal): Promise<void> {
        this.requireOpen();
        if (!this.autoExtract)
            return;
        await withSessionPersistenceLock(this.storage, this.cwd, sessionId, async () => {
            const { hashes, omitted } = selectSessionMemorySource(this.storage, this.cwd, sessionId, baseline);
            if (!hashes.length)
                return;
            const messages = readSessionSourceMessages(this.storage, this.cwd, sessionId, hashes);
            if (messages.some(message => message.role === "user" && message.origin === "user" && SUPPRESS_MEMORY.some(pattern => pattern.test(contentText(message.content)))))
                return;
            const id = createHash("sha256").update(JSON.stringify(["memory-extraction-v1", sessionId, hashes])).digest("hex");
            await this.store.offerFrame({ id, sessionId, messageHashes: hashes, omitted }, signal);
        });
    }
    async maintain(input: {sessionId: string; signal: AbortSignal}): Promise<MemoryMaintenanceResult> {
        this.requireOpen();
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60000)]);
        let result: MemoryMaintenanceResult = {status: "empty", topics: this.store.snapshot().topics.length};
        // Drain arrivals during work without granting an unbounded model loop.
        for (let batch = 0; batch < 4; batch++) {
            throwIfTurnAborted(signal);
            const current = await this.maintainBatch({...input, signal});
            if (current.status === "published" || result.status !== "published") result = current;
            const state = this.store.snapshot();
            if (state.lease || (!state.frames.some(frame => frame.status === "pending") && !state.sources.some(source => !source.consumed))) break;
        }
        return result;
    }
    private async maintainBatch(input: {sessionId: string; signal: AbortSignal}): Promise<MemoryMaintenanceResult> {
        const signal = input.signal;
        await this.store.recoverWorkspaces(signal);
        const extraction = await this.store.claimExtraction(signal);
        if (extraction) {
            const paths = getMemoryWorkspacePaths(this.directory, extraction.lease.id);
            try {
                ensurePrivateStorageDirectory(this.storage, paths.runtime);
                const extractor = this.createExtractor(this.storage);
                const results: Array<Parameters<MemoryPublicationStore["finishExtraction"]>[1][number]> = [];
                for (const frame of extraction.frames) {
                    let messages;
                    try {
                        messages = await withSessionPersistenceLock(this.storage, this.cwd, frame.sessionId, async () => readSessionSourceMessages(this.storage, this.cwd, frame.sessionId, frame.messageHashes));
                    }
                    catch {
                        throwIfTurnAborted(signal);
                        results.push({ frame, facts: [], unavailable: true });
                        continue;
                    }
                    const facts = await extractor.extract(messages.map(message => ({...message, content: contentText(message.content)})), signal, frame.omitted);
                    results.push({ frame, facts, unavailable: false });
                }
                await withSessionPersistenceLock(this.storage, this.cwd, extraction.frames.map(frame => frame.sessionId), async () => {
                    for (const result of results) {
                        if (result.unavailable)
                            continue;
                        try {
                            readSessionSourceMessages(this.storage, this.cwd, result.frame.sessionId, result.frame.messageHashes);
                        }
                        catch {
                            throwIfTurnAborted(signal);
                            result.facts = [];
                            result.unavailable = true;
                        }
                    }
                    await this.store.finishExtraction(extraction.lease, results, signal);
                });
            }
            catch (error) {
                await this.store.fail(extraction.lease, "Memory source extraction failed or was cancelled; sources were not consumed");
                throw error;
            }
            finally {
                ensurePrivateStorageDirectory(this.storage, paths.root);
                await rm(paths.root, { recursive: true, force: true });
            }
        }
        const job = await this.store.claim(signal);
        if (!job)
            return { status: this.store.snapshot().lease ? "busy" : "empty", topics: this.store.snapshot().topics.length };
        try {
            const draft = await this.createConsolidator().consolidate({ ...job, sessionId: input.sessionId, signal });
            await withSessionPersistenceLock(this.storage, this.cwd, job.baseline.sources.flatMap(source => source.origin.kind === "session" ? [source.origin.sessionId] : []), async () => {
                for (const source of job.baseline.sources.filter(source => draft.topics.some(topic => topic.sources.includes(source.id)))) {
                    if (source.origin.kind === "session")
                        readSessionSourceMessages(this.storage, this.cwd, source.origin.sessionId, source.origin.messageHashes);
                }
                await this.store.publish(job.lease, draft.topics, signal);
            });
            return { status: "published", topics: draft.topics.length };
        }
        catch (error) {
            await this.store.fail(job.lease, signal.aborted ? "Memory consolidation cancelled; inspect status for pending sources and partial file edits" : "Memory consolidation failed; inspect status and topic files before retrying");
            throw error;
        }
    }
    async close(): Promise<void> { this.closed = true; }
}
interface MemoryRuntimeFactoryDependencies {
    createStore(storage: HiCodeStorageLayout, cwd: string): MemoryPublicationStore;
    createConsolidator: typeof createMemoryConsolidator;
    createExtractor: typeof createMemorySourceExtractor;
}
export function createMemoryRuntimeFactory(overrides: Partial<MemoryRuntimeFactoryDependencies> = {}) {
    return (options: {
        storage: HiCodeStorageLayout;
        cwd: string;
        shellRunner: ShellRunnerLike;
        settings: ResolvedHiCodeSettings["memory"];
        contextSettings: ResolvedHiCodeSettings["context"];
        getModelTarget(): ModelTargetSettings;
        getModelSource(source: ModelTargetSettings["source"]): ResolvedHiCodeSettings["sources"][ModelTargetSettings["source"]];
    }): MemoryRuntimeLike => {
        const store = (overrides.createStore ?? ((storage, cwd) => new MemoryPublicationStore(storage, cwd)))(options.storage, options.cwd);
        return new MemoryRuntime(options.settings.enabled, options.settings.autoExtract, store, () => {
            const target = options.getModelTarget();
            return (overrides.createConsolidator ?? createMemoryConsolidator)({ ...options, target, source: options.getModelSource(target.source) });
        }, options.storage, options.cwd, (storage) => {
            const target = options.getModelTarget();
            return (overrides.createExtractor ?? createMemorySourceExtractor)({ storage, cwd: options.cwd, target, source: options.getModelSource(target.source) });
        });
    };
}
export const createMemoryRuntime = createMemoryRuntimeFactory();
export function createMemoryAwareAgentRunner(baseRunAgent: AgentRunner, memory: MemoryRuntimeLike): AgentRunner {
    return async (userInput, history, onEvent, ctx, channel, options) => {
        if (!memory.enabled)
            return baseRunAgent(userInput, history, onEvent, ctx, channel, options);
        const revision = memory.getRevision();
        const recalled = await memory.contextForTurn(contentText(userInput));
        const scoped: typeof ctx = {
            ...ctx,
            // The Memory overlay must not freeze the Host's live permission state.
            get permissionRules() {return ctx.permissionRules;},
            get permissionMode() {return ctx.permissionMode;},
            get collaborationMode() {return ctx.collaborationMode;},
            get permissionPromptPolicy() {return ctx.permissionPromptPolicy;},
            memoryFiles: recalled.ignoredForTurn ? undefined : ctx.memoryFiles,
        };
        const result = await baseRunAgent(userInput, history, onEvent, scoped, channel, { ...options,
            getAdditionalUserContextBlocks: async () => {
                const current = recalled.ignoredForTurn ? recalled : await memory.contextForTurn(contentText(userInput));
                if (current.ignoredForTurn)
                    scoped.memoryFiles = undefined;
                return [...(current.block ? [current.block] : []), ...(await options.getAdditionalUserContextBlocks?.() ?? [])];
            } });
        const changes = memory.explicitChangesSince(revision, ctx);
        if (changes.length)
            await onEvent({ type: "memory_update", source: "explicit", changes });
        return result;
    };
}
