import type {AgentRunner} from "../agent/index.js";
import type {ResolvedPillarSettings} from "../settings/index.js";
import type {ModelTargetSettings} from "../settings/types.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import {getMemoryInboxDirectory, getMemoryViewsDirectory} from "../persistence/layout.js";
import {join} from "node:path";
import {createMemoryConsolidator, type MemoryConsolidator} from "./consolidator.js";
import {createPublicationFileAccess} from "./publicationAccess.js";
import {formatPublicationContext} from "./publicationPrompt.js";
import {MemoryPublicationStore} from "./publicationStore.js";
import type {MemoryChange, MemoryContextResult, MemoryEntry, MemoryFileAccess, MemoryRuntimeStatus, MemoryScanResult} from "./types.js";

const SUPPRESS_MEMORY = [/忽略.{0,8}(?:memory|记忆)/i, /不要.{0,8}(?:使用|读取|参考).{0,8}(?:memory|记忆)/i,
    /(?:ignore|do not use|don't use).{0,20}memor/i];

type FileOwner = Parameters<typeof createPublicationFileAccess>[1];
export interface MemoryMaintenanceResult {
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
    explicitChangesSince(revision: number): MemoryChange[];
    maintain(input: {sessionId: string; signal: AbortSignal}): Promise<MemoryMaintenanceResult>;
    close(): Promise<void>;
}

class MemoryRuntime implements MemoryRuntimeLike {
    private notificationRevision = 0;
    private readonly changes: Array<{revision: number; change: MemoryChange}> = [];
    private readonly controller = new AbortController();
    private readonly active = new Set<Promise<MemoryMaintenanceResult>>();
    readonly directory: string;
    constructor(readonly enabled: boolean, readonly autoExtract: boolean, private readonly store: MemoryPublicationStore,
        private readonly createConsolidator: () => MemoryConsolidator) {this.directory = store.directory;}

    private requireOpen(): void {
        if (!this.enabled) throw new Error("Memory 已关闭");
        throwIfTurnAborted(this.controller.signal);
    }
    private record(change: MemoryChange): MemoryChange {
        this.changes.push({revision: ++this.notificationRevision, change});
        if (this.changes.length > 100) this.changes.shift();
        return change;
    }
    getRevision(): number {return this.notificationRevision;}
    explicitChangesSince(revision: number): MemoryChange[] {return this.changes.filter(entry => entry.revision > revision).map(entry => entry.change);}

    async list(): Promise<MemoryScanResult> {
        if (!this.enabled) return {entries: [], issues: []};
        const state = this.store.snapshot();
        const entries: MemoryEntry[] = state.topics.map(topic => ({version: 2, key: topic.key, name: topic.name,
            description: topic.description, type: topic.type, source: state.sources.some(source => topic.sources.includes(source.id) && source.origin.kind === "explicit") ? "explicit" : "automatic",
            createdAt: topic.createdAt, updatedAt: topic.updatedAt, content: topic.content, path: join(getMemoryViewsDirectory(this.directory), `${topic.key}.md`)}));
        for (const source of state.sources.filter(source => !source.consumed)) {
            const existing = entries.findIndex(entry => entry.key === source.key);
            const pending: MemoryEntry = {version: 2, key: source.key, name: source.key, description: "已记录，待整理",
                type: source.type, source: source.origin.kind === "explicit" ? "explicit" : "automatic", createdAt: source.createdAt,
                updatedAt: source.createdAt, content: source.content, path: join(getMemoryInboxDirectory(this.directory), `${source.key}.md`)};
            if (existing >= 0) entries[existing] = pending; else entries.push(pending);
        }
        return {entries, issues: [state.lastIssue, this.store.viewIssue].filter((issue): issue is string => !!issue).map(message => ({path: this.directory, message}))};
    }
    async read(key: string): Promise<MemoryEntry | undefined> {return (await this.list()).entries.find(entry => entry.key === key);}
    async forget(key: string, signal: AbortSignal): Promise<MemoryChange | undefined> {
        this.requireOpen();
        const existing = await this.read(key);
        const removed = await this.store.forget(key, signal);
        return removed && existing ? this.record({action: "forgotten", key, memoryType: existing.type}) : undefined;
    }
    async status(): Promise<MemoryRuntimeStatus> {
        const scan = await this.list();
        const state = this.enabled ? this.store.snapshot() : undefined;
        const counts: MemoryRuntimeStatus["counts"] = {user: 0, feedback: 0, project: 0, reference: 0};
        for (const entry of scan.entries) counts[entry.type]++;
        return {enabled: this.enabled, autoExtract: this.enabled && this.autoExtract, directory: this.directory, counts, issues: scan.issues,
            pending: state?.sources.filter(source => !source.consumed).length ?? 0, published: state?.topics.length ?? 0,
            maintaining: Boolean(state?.lease && Date.parse(state.lease.expiresAt) > Date.now())};
    }
    async contextForTurn(userInput: string): Promise<MemoryContextResult> {
        if (!this.enabled) return {ignoredForTurn: false};
        if (SUPPRESS_MEMORY.some(pattern => pattern.test(userInput))) return {ignoredForTurn: true,
            block: "<system-reminder>用户本轮要求忽略 Memory；Memory 文件能力已收窄，不读取、维护或应用已保存记忆。</system-reminder>"};
        try {
            await this.store.prepareView({kind: "index"});
            return {ignoredForTurn: false, block: formatPublicationContext(this.directory, this.store.snapshot())};
        } catch {return {ignoredForTurn: true, block: "<system-reminder>Memory 发布状态读取失败，本轮不读取或维护 Memory，不假设存在已保存内容。</system-reminder>"};}
    }
    fileAccess(owner: FileOwner): MemoryFileAccess {
        const access = createPublicationFileAccess(this.store, owner);
        return {...access,
            prepare: async (path, tool) => {this.requireOpen(); await access.prepare(path, tool);},
            validateWrite: (path, content) => {this.requireOpen(); access.validateWrite(path, content);},
            write: async (...args) => {this.requireOpen(); return this.record(await access.write(...args));},
            delete: async (...args) => {this.requireOpen(); const change = await access.delete(...args); return change ? this.record(change) : undefined;}};
    }
    maintain(input: {sessionId: string; signal: AbortSignal}): Promise<MemoryMaintenanceResult> {
        this.requireOpen();
        const signal = AbortSignal.any([input.signal, this.controller.signal]);
        const pending = (async (): Promise<MemoryMaintenanceResult> => {
            const job = await this.store.claim(signal);
            if (!job) return {status: this.store.snapshot().lease ? "busy" : "empty", topics: this.store.snapshot().topics.length};
            try {
                const draft = await this.createConsolidator().consolidate({...job, sessionId: input.sessionId, signal});
                await this.store.publish(job.lease, draft.topics, draft.summary, signal);
                return {status: "published", topics: draft.topics.length};
            } catch (error) {
                await this.store.fail(job.lease, signal.aborted ? "Memory 整理已取消，note 保留待处理" : "Memory 整理失败，正式内容未替换，note 保留待处理");
                throw error;
            }
        })();
        this.active.add(pending);
        void pending.finally(() => this.active.delete(pending)).catch(() => {});
        return pending;
    }
    async close(): Promise<void> {
        this.controller.abort("shutdown");
        await Promise.allSettled([...this.active]);
    }
}

export interface MemoryRuntimeFactoryDependencies {
    createStore(storage: PillarStorageLayout, cwd: string): MemoryPublicationStore;
    createConsolidator: typeof createMemoryConsolidator;
}
export function createMemoryRuntimeFactory(overrides: Partial<MemoryRuntimeFactoryDependencies> = {}) {
    return (options: {storage: PillarStorageLayout; cwd: string; environment: ChildProcessEnvironment; shellRunner: ShellRunnerLike;
        settings: ResolvedPillarSettings["memory"]; getModelTarget(): ModelTargetSettings;
        getModelSource(source: ModelTargetSettings["source"]): ResolvedPillarSettings["sources"][ModelTargetSettings["source"]]}): MemoryRuntimeLike => {
        const store = (overrides.createStore ?? ((storage, cwd) => new MemoryPublicationStore(storage, cwd)))(options.storage, options.cwd);
        return new MemoryRuntime(options.settings.enabled, options.settings.autoExtract, store, () => {
            const target = options.getModelTarget();
            return (overrides.createConsolidator ?? createMemoryConsolidator)({...options, target, source: options.getModelSource(target.source)});
        });
    };
}
export const createMemoryRuntime = createMemoryRuntimeFactory();

export function createMemoryAwareAgentRunner(baseRunAgent: AgentRunner, memory: MemoryRuntimeLike): AgentRunner {
    return async (userInput, history, onEvent, ctx, channel, options) => {
        if (!memory.enabled) return baseRunAgent(userInput, history, onEvent, ctx, channel, options);
        const revision = memory.getRevision();
        const recalled = await memory.contextForTurn(userInput);
        const scoped = recalled.ignoredForTurn ? {...ctx, memoryFiles: undefined} : ctx;
        const result = await baseRunAgent(userInput, history, onEvent, scoped, channel, {...options,
            additionalUserContextBlocks: [...(recalled.block ? [recalled.block] : []), ...options.additionalUserContextBlocks ?? []]});
        const changes = memory.explicitChangesSince(revision);
        if (changes.length) await onEvent({type: "memory_update", source: "explicit", changes});
        return result;
    };
}
