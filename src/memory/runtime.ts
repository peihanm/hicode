import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { selectSessionMemorySource, readSessionSourceIds, readSessionSourceMessages, withSessionPersistenceLock } from "../session/snapshotStore.js";
import { createPillarStorageLayout, ensurePrivateStorageDirectory } from "../persistence/index.js";
import { getMemoryWorkspacePaths } from "../persistence/layout.js";
import { createMemorySourceExtractor, type MemorySourceExtractor } from "./sourceExtractor.js";
import type { AgentRunner } from "../agent/index.js";
import type { ResolvedPillarSettings } from "../settings/index.js";
import type { ModelTargetSettings } from "../settings/types.js";
import type { ShellRunnerLike } from "../tools/bash/shellRunner.js";
import type { PillarStorageLayout } from "../persistence/index.js";
import type { ChildProcessEnvironment } from "../runtime/childEnvironment.js";
import { throwIfTurnAborted } from "../runtime/abort.js";
import { getMemoryInboxDirectory, getMemoryViewsDirectory } from "../persistence/layout.js";
import { join } from "node:path";
import { createMemoryConsolidator, type MemoryConsolidator } from "./consolidator.js";
import { createPublicationFileAccess } from "./publicationAccess.js";
import { formatPublicationContext } from "./publicationPrompt.js";
import { MemoryPublicationStore } from "./publicationStore.js";
import type { MemoryChange, MemoryContextResult, MemoryEntry, MemoryFileAccess, MemoryRuntimeStatus, MemoryScanResult } from "./types.js";
const SUPPRESS_MEMORY = [/忽略.{0,8}(?:memory|记忆)/i, /不要.{0,8}(?:使用|读取|参考).{0,8}(?:memory|记忆)/i,
    /(?:ignore|do not use|don't use).{0,20}memor/i];
type FileOwner = Parameters<typeof createPublicationFileAccess>[1];
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
    forget(key: string, signal: AbortSignal): Promise<MemoryChange | undefined>;
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
    constructor(readonly enabled: boolean, readonly autoExtract: boolean, private readonly store: MemoryPublicationStore, private readonly createConsolidator: () => MemoryConsolidator, private readonly storage: PillarStorageLayout, private readonly cwd: string, private readonly createExtractor: (storage: PillarStorageLayout) => MemorySourceExtractor) { this.directory = store.directory; }
    private requireOpen(): void {
        if (!this.enabled)
            throw new Error("Memory 已关闭");
        if (this.closed)
            throw new Error("Memory 已关闭");
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
        const state = this.store.snapshot();
        const entries: MemoryEntry[] = state.topics.map(topic => ({ version: 2, key: topic.key, name: topic.name,
            description: topic.description, type: topic.type, source: state.sources.some(source => topic.sources.includes(source.id) && source.origin.kind === "explicit") ? "explicit" : "automatic",
            evidence: state.sources.filter(source => topic.sources.includes(source.id)).map(source => source.origin),
            createdAt: topic.createdAt, updatedAt: topic.updatedAt, content: topic.content, path: join(getMemoryViewsDirectory(this.directory), `${topic.key}.md`) }));
        for (const source of state.sources.filter(source => !source.consumed)) {
            const existing = entries.findIndex(entry => entry.key === source.key);
            const pending: MemoryEntry = { version: 2, key: source.key, name: source.key, description: "已记录，待整理",
                type: source.type, source: source.origin.kind === "explicit" ? "explicit" : "automatic", evidence: [source.origin], createdAt: source.createdAt,
                updatedAt: source.createdAt, content: source.content, path: join(source.origin.kind === "explicit" ? getMemoryInboxDirectory(this.directory) : getMemoryViewsDirectory(this.directory), `${source.key}.md`) };
            if (existing >= 0)
                entries[existing] = pending;
            else
                entries.push(pending);
        }
        return { entries, issues: [state.lastIssue, this.store.viewIssue, await this.store.legacyIssue()].filter((issue): issue is string => !!issue).map(message => ({ path: this.directory, message })) };
    }
    async read(key: string): Promise<MemoryEntry | undefined> { return (await this.list()).entries.find(entry => entry.key === key); }
    async forget(key: string, signal: AbortSignal): Promise<MemoryChange | undefined> {
        this.requireOpen();
        const existing = await this.read(key);
        const removed = await this.store.forget(key, signal);
        return removed && existing ? { action: "forgotten", key, memoryType: existing.type } : undefined;
    }
    async status(): Promise<MemoryRuntimeStatus> {
        const scan = await this.list();
        const state = this.enabled ? this.store.snapshot() : undefined;
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
                block: "<system-reminder>用户本轮要求忽略 Memory；Memory 文件能力已收窄，不读取、维护或应用已保存记忆。</system-reminder>" };
        try {
            await this.store.prepareView({ kind: "index" });
            return { ignoredForTurn: false, block: formatPublicationContext(this.directory, this.store.snapshot(), await this.store.legacyIssue()) };
        }
        catch {
            return { ignoredForTurn: true, block: "<system-reminder>Memory 发布状态读取失败，本轮不读取或维护 Memory，不假设存在已保存内容。</system-reminder>" };
        }
    }
    fileAccess(owner: FileOwner): MemoryFileAccess {
        const access = createPublicationFileAccess(this.store, owner);
        return { ...access,
            prepare: async (path, tool) => { this.requireOpen(); await access.prepare(path, tool); },
            validateWrite: (path, content) => { this.requireOpen(); access.validateWrite(path, content); },
            write: async (...args) => { this.requireOpen(); return this.record(await access.write(...args), owner); },
            delete: async (...args) => { this.requireOpen(); const change = await access.delete(...args); return change ? this.record(change, owner) : undefined; } };
    }
    async captureBaseline(sessionId: string, prompt: string): Promise<string[] | undefined> {
        if (!this.enabled || !this.autoExtract || this.closed || SUPPRESS_MEMORY.some(pattern => pattern.test(prompt)))
            return undefined;
        try {
            this.store.snapshot();
            return await withSessionPersistenceLock(this.storage, this.cwd, async () => readSessionSourceIds(this.storage, this.cwd, sessionId));
        }
        catch {
            return undefined;
        }
    }
    async captureSource(sessionId: string, baseline: readonly string[], signal: AbortSignal): Promise<void> {
        this.requireOpen();
        if (!this.autoExtract)
            return;
        await withSessionPersistenceLock(this.storage, this.cwd, async () => {
            const { hashes, omitted } = selectSessionMemorySource(this.storage, this.cwd, sessionId, baseline);
            if (!hashes.length)
                return;
            const messages = readSessionSourceMessages(this.storage, this.cwd, sessionId, hashes);
            if (messages.some(message => message.role === "user" && SUPPRESS_MEMORY.some(pattern => pattern.test(message.content ?? ""))))
                return;
            const id = createHash("sha256").update(JSON.stringify(["memory-extraction-v1", sessionId, hashes])).digest("hex");
            await this.store.offerFrame({ id, sessionId, messageHashes: hashes, omitted }, signal);
        });
    }
    async maintain(input: {
        sessionId: string;
        signal: AbortSignal;
    }): Promise<MemoryMaintenanceResult> {
        this.requireOpen();
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5 * 60000)]);
        throwIfTurnAborted(signal);
        await this.store.recoverWorkspaces(signal);
        const extraction = await this.store.claimExtraction(signal);
        if (extraction) {
            const paths = getMemoryWorkspacePaths(this.directory, extraction.lease.id);
            try {
                const temporary = createPillarStorageLayout({ pillarHome: paths.runtime });
                ensurePrivateStorageDirectory(this.storage, paths.runtime);
                const extractor = this.createExtractor(temporary);
                const results: Array<Parameters<MemoryPublicationStore["finishExtraction"]>[1][number]> = [];
                for (const frame of extraction.frames) {
                    let messages;
                    try {
                        messages = await withSessionPersistenceLock(this.storage, this.cwd, async () => readSessionSourceMessages(this.storage, this.cwd, frame.sessionId, frame.messageHashes));
                    }
                    catch {
                        throwIfTurnAborted(signal);
                        results.push({ frame, facts: [], unavailable: true });
                        continue;
                    }
                    const facts = await extractor.extract(messages, signal, frame.omitted);
                    results.push({ frame, facts, unavailable: false });
                }
                await withSessionPersistenceLock(this.storage, this.cwd, async () => {
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
                await this.store.fail(extraction.lease, "Memory 来源提取失败或取消，未消费来源");
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
            await withSessionPersistenceLock(this.storage, this.cwd, async () => {
                for (const source of job.baseline.sources.filter(source => draft.topics.some(topic => topic.sources.includes(source.id)))) {
                    if (source.origin.kind === "session")
                        readSessionSourceMessages(this.storage, this.cwd, source.origin.sessionId, source.origin.messageHashes);
                }
                await this.store.publish(job.lease, draft.topics, draft.summary, signal);
            });
            return { status: "published", topics: draft.topics.length };
        }
        catch (error) {
            await this.store.fail(job.lease, signal.aborted ? "Memory 整理已取消，note 保留待处理" : "Memory 整理失败，正式内容未替换，note 保留待处理");
            throw error;
        }
    }
    async close(): Promise<void> { this.closed = true; }
}
interface MemoryRuntimeFactoryDependencies {
    createStore(storage: PillarStorageLayout, cwd: string): MemoryPublicationStore;
    createConsolidator: typeof createMemoryConsolidator;
    createExtractor: typeof createMemorySourceExtractor;
}
export function createMemoryRuntimeFactory(overrides: Partial<MemoryRuntimeFactoryDependencies> = {}) {
    return (options: {
        storage: PillarStorageLayout;
        cwd: string;
        environment: ChildProcessEnvironment;
        shellRunner: ShellRunnerLike;
        settings: ResolvedPillarSettings["memory"];
        getModelTarget(): ModelTargetSettings;
        getModelSource(source: ModelTargetSettings["source"]): ResolvedPillarSettings["sources"][ModelTargetSettings["source"]];
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
        const recalled = await memory.contextForTurn(userInput);
        const scoped = { ...ctx, memoryFiles: recalled.ignoredForTurn ? undefined : ctx.memoryFiles };
        const result = await baseRunAgent(userInput, history, onEvent, scoped, channel, { ...options,
            getAdditionalUserContextBlocks: async () => {
                const current = recalled.ignoredForTurn ? recalled : await memory.contextForTurn(userInput);
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
