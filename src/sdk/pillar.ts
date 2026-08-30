import {createCompactState} from "../context/index.js";
import type {HookTrustRequest} from "../hooks/index.js";
import type {McpApprovalRequest} from "../mcp/index.js";
import {isPermissionMode} from "../permissions/index.js";
import {createInitialHistory} from "../prompt/index.js";
import {createRootRuntimeResources, type RootRuntimeResources,} from "../runtime/resources.js";
import {createSessionId, loadSession} from "../session/index.js";
import {formatAgentLoadIssue} from "../subagents/diagnostics.js";
import {normalizeInteractionResponse, raceInteractionWithAbort,} from "./interaction.js";
import type {InteractionRequest, InteractionResponse} from "./protocol.js";
import {createSDKThread} from "./thread.js";
import {
    PillarSDKError,
    type HostDiagnostic,
    type PillarOptions,
    type StartThreadOptions,
    type Thread,
} from "./types.js";
import {randomUUID} from "node:crypto";

export class Pillar {
    private activeThread: Thread | undefined;
    private pendingThread: Promise<Thread> | undefined;
    private closePromise: Promise<void> | undefined;
    private closed = false;

    private constructor(
        private readonly options: PillarOptions,
        private readonly resources: RootRuntimeResources,
        private readonly rootController: AbortController
    ) {}

    static async create(options: PillarOptions): Promise<Pillar> {
        validatePillarOptions(options);
        const rootController = new AbortController();
        const requestApproval = (
            request: McpApprovalRequest
        ) => requestRootApproval(
            options,
            rootController.signal,
            {
                requestId: randomUUID(),
                kind: "mcp_approval",
                request,
            }
        );
        const requestTrust = (
            request: HookTrustRequest
        ) => requestRootApproval(
            options,
            rootController.signal,
            {
                requestId: randomUUID(),
                kind: "hook_trust",
                request,
            }
        );
        const resources = await createRootRuntimeResources({
            storage: options.storage,
            cwd: options.cwd,
            settings: options.settings,
            signal: rootController.signal,
            headless: false,
            requestMcpApproval: requestApproval,
            requestHookTrust: requestTrust,
        });
        const pillar = new Pillar(options, resources, rootController);
        await pillar.reportStartupDiagnostics();
        return pillar;
    }

    async startThread(
        options: StartThreadOptions = {}
    ): Promise<Thread> {
        this.assertCanOpenThread();
        if (
            options.permissionMode !== undefined &&
            !isPermissionMode(options.permissionMode)
        ) {
            throw new PillarSDKError(
                "invalid_permission_mode",
                `无效 permissionMode: ${String(options.permissionMode)}`
            );
        }
        const sessionId = createSessionId();
        return this.openThread({
            seed: {
                sessionId,
                history: createInitialHistory(
                    this.resources.cwd,
                    this.resources.model
                ),
                compactState: createCompactState(),
            },
            state: {
                todos: [],
                permissionMode:
                    options.permissionMode ??
                    this.resources.settings.permissions.defaultMode,
                uiEvents: [],
            },
            resumed: false,
        });
    }

    async resumeThread(sessionId: string): Promise<Thread> {
        this.assertCanOpenThread();
        if (typeof sessionId !== "string" || !sessionId.trim()) {
            throw new PillarSDKError(
                "invalid_session_id",
                "resumeThread 需要非空 sessionId"
            );
        }
        const loaded = loadSession(
            this.resources.storage,
            this.resources.cwd,
            sessionId,
            this.resources.model
        );
        if (!loaded) {
            throw new PillarSDKError(
                "session_not_found",
                `没有找到会话: ${sessionId}`
            );
        }
        return this.openThread({
            seed: {
                sessionId: loaded.sessionId,
                history: loaded.history,
                compactState: loaded.compactState ?? createCompactState(),
                checkpointHead: loaded.checkpointHead,
                queuedInputs: loaded.queuedInputs,
                toolDiscovery: loaded.toolDiscovery,
                gitSession: loaded.gitSession,
            },
            state: {
                todos: loaded.todos,
                permissionMode: loaded.permissionMode,
                prePlanMode: loaded.prePlanMode,
                uiEvents: loaded.uiEvents,
            },
            resumed: true,
        });
    }

    close(): Promise<void> {
        this.closePromise ??= this.closeInternal();
        return this.closePromise;
    }

    private openThread(
        input: Omit<Parameters<typeof createSDKThread>[0],
            "resources" | "host" | "onClose">
    ): Promise<Thread> {
        let created: Thread | undefined;
        const operation = (async () => {
            created = await createSDKThread({
                ...input,
                resources: this.resources,
                host: this.options.host,
                signal: this.rootController.signal,
                onClose: () => {
                    if (this.activeThread === created) {
                        this.activeThread = undefined;
                    }
                },
            });
            if (this.closed) {
                await created.close();
                throw new PillarSDKError(
                    "pillar_closed",
                    "Pillar 在 Thread 初始化期间被关闭"
                );
            }
            this.activeThread = created;
            return created;
        })();
        this.pendingThread = operation;
        void operation.finally(() => {
            if (this.pendingThread === operation) {
                this.pendingThread = undefined;
            }
        }).catch(() => {
            // 调用方持有原始 operation；这里只消费 finally 派生 Promise。
        });
        return operation;
    }

    private assertCanOpenThread(): void {
        if (this.closed) {
            throw new PillarSDKError("pillar_closed", "Pillar 已关闭");
        }
        if (this.activeThread || this.pendingThread) {
            throw new PillarSDKError(
                "thread_already_open",
                "一个 Pillar 实例同时只允许一个打开的 Thread"
            );
        }
    }

    private async reportStartupDiagnostics(): Promise<void> {
        if (this.resources.sandbox.status.kind === "unavailable") {
            await this.reportDiagnostic({
                severity: "warning",
                scope: "sandbox",
                message: this.resources.sandbox.status.reason,
            });
        }
        for (const issue of this.resources.subagents.issues) {
            await this.reportDiagnostic({
                severity: issue.severity,
                scope: "agent",
                message: formatAgentLoadIssue(issue),
            });
        }
        for (const issue of this.resources.hooks.issues) {
            await this.reportDiagnostic({
                severity: "warning",
                scope: "hook",
                message: issue.message,
            });
        }
    }

    private async reportDiagnostic(diagnostic: HostDiagnostic): Promise<void> {
        try {
            await this.options.host?.onDiagnostic?.(diagnostic);
        } catch {
            // Host diagnostic sink 不能破坏 Root 生命周期。
        }
    }

    private async closeInternal(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.pendingThread?.catch(() => undefined);
            await this.activeThread?.close();
        } finally {
            if (!this.rootController.signal.aborted) {
                this.rootController.abort("shutdown");
            }
            await this.resources.close();
        }
    }
}

function validatePillarOptions(options: PillarOptions): void {
    if (typeof options.cwd !== "string" || !options.cwd.trim()) {
        throw new PillarSDKError("invalid_cwd", "Pillar cwd 必须是非空字符串");
    }
    if (!options.storage || !options.settings) {
        throw new PillarSDKError(
            "invalid_options",
            "Pillar 需要显式 storage 和 resolved settings"
        );
    }
}

async function requestRootApproval(
    options: PillarOptions,
    signal: AbortSignal,
    request: Extract<
        InteractionRequest,
        {kind: "mcp_approval" | "hook_trust"}
    >
): Promise<"once" | "always" | "deny"> {
    const callback = options.host?.onInteraction;
    if (!callback) return "deny";
    let response: InteractionResponse;
    try {
        response = normalizeInteractionResponse(
            await raceInteractionWithAbort(
                callback(request, {cwd: options.cwd}),
                signal
            )
        );
    } catch (error) {
        try {
            await options.host?.onDiagnostic?.({
                severity: "warning",
                scope: "runtime",
                message: `Root interaction 失败，已拒绝: ${error instanceof Error ? error.message : String(error)}`,
            });
        } catch {
            // Host diagnostic sink 不能扩大审批结果。
        }
        return "deny";
    }
    return response.behavior === "allow"
        ? response.persistence ?? "once"
        : "deny";
}
