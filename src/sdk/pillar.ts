import type {HookTrustRequest} from "../hooks/index.js";
import type {McpApprovalRequest} from "../mcp/index.js";
import {isPermissionMode} from "../permissions/index.js";
import {isCollaborationMode} from "../collaboration/index.js";
import {createRootRuntimeResources, type RootRuntimeResources,} from "../runtime/resources.js";
import {isPillarRootConfiguration} from "../runtime/rootConfiguration.js";
import {loadSession} from "../session/index.js";
import {formatAgentLoadIssue} from "../subagents/diagnostics.js";
import {normalizeInteractionResponse, raceInteractionWithAbort,} from "./interaction.js";
import type {InteractionRequest, InteractionResponse} from "./protocol.js";
import {createSDKThread, prepareThreadSession} from "./thread.js";
import {adaptPillarHostTools} from "./hostTools.js";
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
        const hostTools = adaptPillarHostTools(options.tools);
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
            configuration: options.configuration,
            signal: rootController.signal,
            headless: false,
            requestMcpApproval: requestApproval,
            requestHookTrust: requestTrust,
            additionalTools: hostTools,
        });
        const pillar = new Pillar(options, resources, rootController);
        await pillar.reportStartupDiagnostics();
        return pillar;
    }

    getMcpServers() {
        return this.resources.mcpManager?.getSnapshots() ?? [];
    }

    async reconnectMcpServer(name: string): Promise<void> {
        if (this.closed) throw new Error("Pillar 已关闭");
        if (!this.resources.mcpManager) throw new Error("没有配置 MCP Server");
        await this.resources.mcpManager.reconnect(name);
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
        if (
            options.collaborationMode !== undefined &&
            !isCollaborationMode(options.collaborationMode)
        ) {
            throw new PillarSDKError(
                "invalid_collaboration_mode",
                `无效 collaborationMode: ${String(options.collaborationMode)}`
            );
        }
        if ((options.permissionMode ?? this.resources.settings.permissions.defaultMode) === "full-access" && !this.resources.allowFullAccess) throw new PillarSDKError("permission_mode_not_allowed", "当前 Host 不允许 Full Access");
        const initial = prepareThreadSession(this.resources);
        initial.state.permissionMode = options.permissionMode ?? initial.state.permissionMode;
        initial.state.collaborationMode = options.collaborationMode ?? initial.state.collaborationMode;
        return this.openThread(initial);
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
        return this.openThread(prepareThreadSession(this.resources, loaded));
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
    if (!isPillarRootConfiguration(options.configuration)) {
        throw new PillarSDKError(
            "invalid_options",
            "Pillar 需要由 loadPillarHostConfig 生成的 Root Configuration"
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
                requestSignal => callback(request, {cwd: options.configuration.cwd, signal: requestSignal}),
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
