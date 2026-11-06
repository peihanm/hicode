import type {HookTrustRequest} from "../hooks/index.js";
import type {McpApprovalRequest, McpApprovalDecision} from "../mcp/index.js";
import {isPermissionMode} from "../permissions/index.js";
import {createRootRuntimeResources, type RootRuntimeResources,} from "../runtime/resources.js";
import {isHiCodeRootConfiguration} from "../runtime/rootConfiguration.js";
import {loadSession} from "../session/index.js";
import {formatAgentLoadIssue} from "../subagents/diagnostics.js";
import {requestHostInteraction, reportHostDiagnostic,} from "./interaction.js";
import type {InteractionRequest} from "./protocol.js";
import {createSDKThread, prepareThreadSession} from "./thread.js";
import {adaptHiCodeHostTools} from "./hostTools.js";
import {
    HiCodeSDKError,
    type HiCodeOptions,
    type StartThreadOptions,
    type Thread,
} from "./types.js";
import {randomUUID} from "node:crypto";

export class HiCode {
    private activeThread: Thread | undefined;
    private pendingThread: Promise<Thread> | undefined;
    private closePromise: Promise<void> | undefined;
    private closed = false;

    private constructor(
        private readonly options: HiCodeOptions,
        private readonly resources: RootRuntimeResources,
        private readonly rootController: AbortController
    ) {}

    static async create(options: HiCodeOptions): Promise<HiCode> {
        validateHiCodeOptions(options);
        const hostTools = adaptHiCodeHostTools(options.tools);
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
        ).then<McpApprovalDecision>(decision => decision === "deny" ? "cancel" : "enable");
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
        const hicode = new HiCode(options, resources, rootController);
        await hicode.reportStartupDiagnostics();
        return hicode;
    }

    getMcpServers() {
        return this.resources.mcpManager?.getSnapshots() ?? [];
    }

    async reconnectMcpServer(name: string): Promise<void> {
        if (this.closed) throw new Error("HiCode is closed");
        if (!this.resources.mcpManager) throw new Error("No MCP Servers configured");
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
            throw new HiCodeSDKError(
                "invalid_permission_mode",
                `Invalid permissionMode: ${String(options.permissionMode)}`
            );
        }
        if ((options.permissionMode ?? this.resources.settings.permissions.defaultMode) === "full-access" && !this.resources.allowFullAccess) throw new HiCodeSDKError("permission_mode_not_allowed", "This Host does not allow Full Access");
        const initial = prepareThreadSession(this.resources);
        initial.state.permissionMode = options.permissionMode ?? initial.state.permissionMode;
        return this.openThread(initial);
    }

    async resumeThread(sessionId: string): Promise<Thread> {
        this.assertCanOpenThread();
        if (typeof sessionId !== "string" || !sessionId.trim()) {
            throw new HiCodeSDKError(
                "invalid_session_id",
                "resumeThread requires a non-empty sessionId"
            );
        }
        const loaded = loadSession(
            this.resources.storage,
            this.resources.cwd,
            sessionId
        );
        if (!loaded) {
            throw new HiCodeSDKError(
                "session_not_found",
                `Session not found: ${sessionId}`
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
                throw new HiCodeSDKError(
                    "hicode_closed",
                    "HiCode was closed during Thread initialization"
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
            // The caller owns the original operation; consume only the Promise derived from finally here.
        });
        return operation;
    }

    private assertCanOpenThread(): void {
        if (this.closed) {
            throw new HiCodeSDKError("hicode_closed", "HiCode is closed");
        }
        if (this.activeThread || this.pendingThread) {
            throw new HiCodeSDKError(
                "thread_already_open",
                "A HiCode instance allows only one open Thread at a time"
            );
        }
    }

    private async reportStartupDiagnostics(): Promise<void> {
        if (this.resources.sandbox.status.kind === "unavailable") {
            await reportHostDiagnostic(this.options.host, {
                severity: "warning",
                scope: "sandbox",
                message: this.resources.sandbox.status.reason,
            });
        }
        for (const issue of this.resources.skillIssues) {
            await reportHostDiagnostic(this.options.host, {severity: "warning", scope: "runtime", message: `Skill ${issue.path}: ${issue.message}`});
        }
        for (const issue of this.resources.subagents.issues) {
            await reportHostDiagnostic(this.options.host, {
                severity: issue.severity,
                scope: "agent",
                message: formatAgentLoadIssue(issue),
            });
        }
        for (const issue of this.resources.hooks.issues) {
            await reportHostDiagnostic(this.options.host, {
                severity: "warning",
                scope: "hook",
                message: issue.message,
            });
        }
    }

    private async closeInternal(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (!this.rootController.signal.aborted) this.rootController.abort("shutdown");
        try {
            await this.pendingThread?.catch(() => undefined);
            await this.activeThread?.close();
        } finally {
            await this.resources.close();
        }
    }
}

function validateHiCodeOptions(options: HiCodeOptions): void {
    if (!isHiCodeRootConfiguration(options.configuration)) {
        throw new HiCodeSDKError(
            "invalid_options",
            "HiCode requires a Root Configuration created by loadHiCodeHostConfig"
        );
    }
}

async function requestRootApproval(
    options: HiCodeOptions,
    signal: AbortSignal,
    request: Extract<
        InteractionRequest,
        {kind: "mcp_approval" | "hook_trust"}
    >
): Promise<"once" | "always" | "deny"> {
    const response = await requestHostInteraction(options.host, request, {
        cwd: options.configuration.cwd, signal,
    });
    return response.behavior === "allow"
        ? response.persistence ?? "once"
        : "deny";
}
