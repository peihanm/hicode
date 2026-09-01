import {Buffer} from "node:buffer";
import type {AgentRunner} from "../agent/index.js";
import type {AgentEvent} from "../agent/types.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {LLMSourceConnection} from "../llm/types.js";
import type {CodexAppServerRuntimeLike} from "../llm/providers/codex/index.js";
import type {ResolvedPillarSettings} from "../settings/index.js";
import type {ModelTargetSettings} from "../settings/types.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {createMemoryExtractor, type MemoryExtractor} from "./extractor.js";
import {classifyMemoryPath, getMemoryDirectory} from "./paths.js";
import {formatMemoryContext} from "./prompt.js";
import {boundMemoryIndex, MemoryStore, type MemoryStoreLike} from "./store.js";
import type {
    MemoryChange,
    MemoryContextResult,
    MemoryEntry,
    MemoryFileAccess,
    MemoryIssue,
    MemoryRuntimeStatus,
    MemoryScanResult,
    MemorySource,
    MemoryUpsertInput,
} from "./types.js";

const BUFFER_TURN_LIMIT = 8;
const BUFFER_MESSAGE_LIMIT = 20;
const BUFFER_BYTES_LIMIT = 32 * 1024;
const CLOSE_FLUSH_TIMEOUT_MS = 15_000;
const ISSUE_LIMIT = 20;

const HIGH_VALUE_MEMORY_SIGNAL = [
    /记住|别忘|忘记|不要记/i,
    /以后|今后|总是|从不|偏好|喜欢|不喜欢|不要再/i,
    /我是|我的职责|我负责|我熟悉|我不熟悉/i,
    /截止|期限|发布|冻结|事故|原因是|动机/i,
    /https?:\/\//i,
    /remember|forget|from now on|always|never|prefer|deadline|because/i,
];

const SUPPRESS_MEMORY = [
    /忽略.{0,8}(?:memory|记忆)/i,
    /不要.{0,8}(?:使用|读取|参考).{0,8}(?:memory|记忆)/i,
    /(?:ignore|do not use|don't use).{0,20}memor/i,
];

interface BufferedTurn {
    user: string;
    assistant: string;
}

interface ExtractionBatch {
    turns: BufferedTurn[];
    onEvent: (event: AgentEvent) => void | Promise<void>;
}

interface JournalEntry {
    revision: number;
    source: MemorySource;
    change: MemoryChange;
}

function truncateUtf8(value: string, maxBytes: number): string {
    const source = Buffer.from(value, "utf8");
    if (source.length <= maxBytes) return value;
    let end = maxBytes;
    while (end > 0 && (source[end]! & 0xc0) === 0x80) end -= 1;
    return source.subarray(0, end).toString("utf8");
}

export interface MemoryRuntimeLike {
    readonly enabled: boolean;
    readonly autoExtract: boolean;
    readonly directory: string;

    list(): Promise<MemoryScanResult>;

    read(key: string): Promise<MemoryEntry | undefined>;

    upsert(input: MemoryUpsertInput): Promise<MemoryChange>;

    forget(key: string): Promise<MemoryChange | undefined>;

    rebuildIndex(): Promise<MemoryScanResult>;

    status(): Promise<MemoryRuntimeStatus>;

    contextForTurn(userInput: string): Promise<MemoryContextResult>;

    fileAccess(source: MemorySource): MemoryFileAccess;

    reconcileIndex(): Promise<MemoryScanResult>;

    getRevision(): number;

    explicitChangesSince(revision: number): MemoryChange[];

    considerCompletedTurn(input: {
        userInput: string;
        assistantText: string;
        onEvent: (event: AgentEvent) => void | Promise<void>;
    }): void;

    close(): Promise<void>;
}

class MemoryRuntime implements MemoryRuntimeLike {
    private revision = 0;
    private readonly journal: JournalEntry[] = [];
    private readonly runtimeIssues: MemoryIssue[] = [];
    private buffer: BufferedTurn[] = [];
    private bufferOnEvent: ExtractionBatch["onEvent"] | undefined;
    private running: Promise<void> | undefined;
    private trailing: ExtractionBatch | undefined;
    private closed = false;
    private readonly controller = new AbortController();

    constructor(
        readonly directory: string,
        readonly enabled: boolean,
        readonly autoExtract: boolean,
        private readonly store: MemoryStoreLike,
        private readonly createExtractor: (
            memoryFiles: MemoryFileAccess
        ) => MemoryExtractor
    ) {
    }

    private record(change: MemoryChange, source: MemorySource): MemoryChange {
        this.revision += 1;
        this.journal.push({revision: this.revision, source, change});
        if (this.journal.length > 100) {
            this.journal.splice(0, this.journal.length - 100);
        }
        return change;
    }

    private addIssue(message: string): void {
        this.runtimeIssues.push({path: this.directory, message});
        if (this.runtimeIssues.length > ISSUE_LIMIT) {
            this.runtimeIssues.splice(0, this.runtimeIssues.length - ISSUE_LIMIT);
        }
    }

    getRevision(): number {
        return this.revision;
    }

    explicitChangesSince(revision: number): MemoryChange[] {
        return this.changesSince(revision, "explicit");
    }

    private changesSince(
        revision: number,
        source: MemorySource
    ): MemoryChange[] {
        return this.journal
            .filter((entry) =>
                entry.revision > revision && entry.source === source
            )
            .map((entry) => entry.change);
    }

    list(): Promise<MemoryScanResult> {
        return this.store.list();
    }

    read(key: string): Promise<MemoryEntry | undefined> {
        return this.store.read(key);
    }

    async upsert(input: MemoryUpsertInput): Promise<MemoryChange> {
        if (!this.enabled) throw new Error("Memory 已关闭");
        return this.record(await this.store.upsert(input), input.source);
    }

    private async forgetWithSource(
        key: string,
        source: MemorySource
    ): Promise<MemoryChange | undefined> {
        if (!this.enabled) throw new Error("Memory 已关闭");
        const change = await this.store.forget(key);
        return change ? this.record(change, source) : undefined;
    }

    forget(key: string): Promise<MemoryChange | undefined> {
        return this.forgetWithSource(key, "explicit");
    }

    rebuildIndex(): Promise<MemoryScanResult> {
        if (!this.enabled) throw new Error("Memory 已关闭");
        return this.store.rebuildIndex();
    }

    reconcileIndex(): Promise<MemoryScanResult> {
        if (!this.enabled) return Promise.resolve({entries: [], issues: []});
        return this.store.reconcileIndex();
    }

    async status(): Promise<MemoryRuntimeStatus> {
        const scan = this.enabled
            ? await this.store.list().catch((error) => {
                this.addIssue(error instanceof Error ? error.message : String(error));
                return {entries: [], issues: []};
            })
            : {entries: [], issues: []};
        const counts: MemoryRuntimeStatus["counts"] = {
            user: 0,
            feedback: 0,
            project: 0,
            reference: 0,
        };
        for (const entry of scan.entries) counts[entry.type] += 1;
        return {
            enabled: this.enabled,
            autoExtract: this.enabled && this.autoExtract,
            directory: this.directory,
            counts,
            issues: [...scan.issues, ...this.runtimeIssues],
        };
    }

    async contextForTurn(userInput: string): Promise<MemoryContextResult> {
        if (!this.enabled) return {ignoredForTurn: false};
        if (SUPPRESS_MEMORY.some((pattern) => pattern.test(userInput))) {
            return {
                ignoredForTurn: true,
                block: [
                    "<system-reminder>",
                    "用户已明确要求本轮忽略持久 Memory。不得读取、应用、引用、维护或提及任何已保存 Memory。",
                    "</system-reminder>",
                ].join("\n"),
            };
        }
        try {
            const scan = await this.store.reconcileIndex();
            for (const issue of scan.issues) this.addIssue(issue.message);
            const bounded = boundMemoryIndex(await this.store.readIndex());
            return {
                ignoredForTurn: false,
                block: formatMemoryContext({
                    directory: this.directory,
                    index: bounded.content || "# Pillar Memory",
                    truncated: bounded.truncated,
                }),
            };
        } catch (error) {
            this.addIssue(`Memory 索引加载失败: ${error instanceof Error ? error.message : String(error)}`);
            return {
                ignoredForTurn: false,
                block: "<system-reminder>\nMemory 索引读取失败。本轮不要假设存在任何已保存 Memory，也不要尝试维护 Memory。\n</system-reminder>",
            };
        }
    }

    fileAccess(source: MemorySource): MemoryFileAccess {
        return {
            directory: this.directory,
            classify: (path) => classifyMemoryPath(this.directory, path),
            validateWrite: (path, content) => {
                if (!this.enabled) throw new Error("Memory 已关闭");
                this.store.validateManagedWrite(path, content);
            },
            write: async (path, content, expectedContent) => {
                if (!this.enabled) throw new Error("Memory 已关闭");
                const change = await this.store.writeManagedFile(
                    path,
                    content,
                    expectedContent
                );
                return change ? this.record(change, source) : undefined;
            },
            delete: async (path, expectedContent) => {
                if (!this.enabled) throw new Error("Memory 已关闭");
                const change = await this.store.deleteManagedFile(
                    path,
                    expectedContent
                );
                return change ? this.record(change, source) : undefined;
            },
        };
    }

    private bufferBytes(): number {
        return this.buffer.reduce(
            (total, turn) =>
                total + Buffer.byteLength(turn.user + turn.assistant, "utf8"),
            0
        );
    }

    private addBufferedTurn(turn: BufferedTurn): void {
        this.buffer.push({
            user: truncateUtf8(turn.user, BUFFER_BYTES_LIMIT / 2),
            assistant: truncateUtf8(turn.assistant, BUFFER_BYTES_LIMIT / 2),
        });
        while (
            this.buffer.length * 2 > BUFFER_MESSAGE_LIMIT ||
            this.bufferBytes() > BUFFER_BYTES_LIMIT
            ) {
            this.buffer.shift();
        }
    }

    considerCompletedTurn({
                              userInput,
                              assistantText,
                              onEvent,
                          }: {
        userInput: string;
        assistantText: string;
        onEvent: (event: AgentEvent) => void | Promise<void>;
    }): void {
        if (!this.enabled || !this.autoExtract || this.closed) return;
        this.addBufferedTurn({user: userInput, assistant: assistantText});
        this.bufferOnEvent = onEvent;
        const immediate = HIGH_VALUE_MEMORY_SIGNAL.some((pattern) =>
            pattern.test(userInput)
        );
        if (!immediate && this.buffer.length < BUFFER_TURN_LIMIT) return;
        const turns = this.buffer;
        this.buffer = [];
        this.bufferOnEvent = undefined;
        this.enqueue({turns, onEvent});
    }

    private enqueue(batch: ExtractionBatch): void {
        if (this.closed) return;
        if (this.running) {
            this.trailing = this.trailing
                ? {
                    turns: [...this.trailing.turns, ...batch.turns].slice(-BUFFER_TURN_LIMIT),
                    onEvent: batch.onEvent,
                }
                : batch;
            return;
        }
        this.running = this.runQueue(batch).finally(() => {
            this.running = undefined;
            const trailing = this.trailing;
            this.trailing = undefined;
            if (trailing && !this.closed) this.enqueue(trailing);
        });
    }

    private async runQueue(initial: ExtractionBatch): Promise<void> {
        let current: ExtractionBatch | undefined = initial;
        while (current && !this.controller.signal.aborted) {
            await this.extractBatch(current);
            current = this.trailing;
            this.trailing = undefined;
        }
    }

    private async extractBatch(batch: ExtractionBatch): Promise<void> {
        try {
            const revision = this.getRevision();
            const extractor = this.createExtractor(this.fileAccess("automatic"));
            await extractor.extract({
                turns: batch.turns,
                signal: this.controller.signal,
            });
            const scan = await this.store.reconcileIndex();
            for (const issue of scan.issues) this.addIssue(issue.message);
            const changes = this.changesSince(revision, "automatic");
            if (changes.length > 0) {
                try {
                    await batch.onEvent({
                        type: "memory_update",
                        source: "automatic",
                        changes,
                    });
                } catch (error) {
                    this.addIssue(
                        `自动更新已保存，但事件发布失败: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        } catch (error) {
            if (this.controller.signal.aborted) return;
            this.addIssue(
                `自动提取失败: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.buffer.length > 0) {
            const buffered: ExtractionBatch = {
                turns: this.buffer,
                onEvent: this.bufferOnEvent ?? (() => {}),
            };
            this.buffer = [];
            this.bufferOnEvent = undefined;
            if (this.running) {
                this.trailing = this.trailing
                    ? {
                        turns: [...this.trailing.turns, ...buffered.turns]
                            .slice(-BUFFER_TURN_LIMIT),
                        onEvent: buffered.onEvent,
                    }
                    : buffered;
            } else {
                this.running = this.runQueue(buffered).finally(() => {
                    this.running = undefined;
                    this.trailing = undefined;
                });
            }
        }
        const running = this.running;
        if (!running) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                running,
                new Promise<void>((resolve) => {
                    timer = setTimeout(() => {
                        this.controller.abort("memory-close-timeout");
                        resolve();
                    }, CLOSE_FLUSH_TIMEOUT_MS);
                    timer.unref?.();
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

export interface MemoryRuntimeFactoryDependencies {
    createStore(directory: string): MemoryStoreLike;

    createExtractor(options: {
        storage: PillarStorageLayout;
        cwd: string;
        model: string;
        provider: LLMProviderName;
        source: LLMSourceConnection;
        shellRunner: ShellRunnerLike;
        memoryFiles: MemoryFileAccess;
        codex?: CodexAppServerRuntimeLike;
    }): MemoryExtractor;
}

export function createMemoryRuntimeFactory(
    overrides: Partial<MemoryRuntimeFactoryDependencies> = {}
) {
    const createStore =
        overrides.createStore ?? ((directory: string) => new MemoryStore(directory));
    const createExtractor =
        overrides.createExtractor ??
        ((options) => createMemoryExtractor(options));
    return function createMemoryRuntime(options: {
        storage: PillarStorageLayout;
        cwd: string;
        getModelTarget(): ModelTargetSettings;
        getModelSource(
            source: ModelTargetSettings["source"]
        ): ResolvedPillarSettings["sources"][ModelTargetSettings["source"]];
        shellRunner: ShellRunnerLike;
        settings: ResolvedPillarSettings["memory"];
        codex?: CodexAppServerRuntimeLike;
    }): MemoryRuntimeLike {
        const directory = getMemoryDirectory(options.storage, options.cwd);
        const store = createStore(directory);
        return new MemoryRuntime(
            store.directory,
            options.settings.enabled,
            options.settings.autoExtract,
            store,
            (memoryFiles) => {
                const target = options.getModelTarget();
                return createExtractor({
                    storage: options.storage,
                    model: target.model,
                    provider: target.provider,
                    source: options.getModelSource(target.source),
                    cwd: options.cwd,
                    shellRunner: options.shellRunner,
                    memoryFiles,
                    codex: options.codex,
                });
            }
        );
    };
}

export const createMemoryRuntime = createMemoryRuntimeFactory();

export function createMemoryAwareAgentRunner(
    baseRunAgent: AgentRunner,
    memory: MemoryRuntimeLike
): AgentRunner {
    return async (
        userInput,
        history,
        onEvent,
        ctx,
        inputChannel,
        options
    ) => {
        if (!memory.enabled) {
            return baseRunAgent(
                userInput,
                history,
                onEvent,
                ctx,
                inputChannel,
                options
            );
        }
        const revision = memory.getRevision();
        const memoryContext = await memory.contextForTurn(userInput);
        const result = await baseRunAgent(userInput, history, onEvent, ctx, inputChannel, {
            ...options,
            additionalUserContextBlocks: [
                ...(memoryContext.block ? [memoryContext.block] : []),
                ...(options.additionalUserContextBlocks ?? []),
            ],
        });
        if (!memoryContext.ignoredForTurn) {
            await memory.reconcileIndex().catch(() => undefined);
        }
        const explicitChanges = memory.explicitChangesSince(revision);
        if (explicitChanges.length > 0) {
            await onEvent({
                type: "memory_update",
                source: "explicit",
                changes: explicitChanges,
            });
        } else if (
            !memoryContext.ignoredForTurn &&
            result.reason === "completed" &&
            result.reply.trim()
        ) {
            memory.considerCompletedTurn({
                userInput,
                assistantText: result.reply,
                onEvent,
            });
        }
        return result;
    };
}
