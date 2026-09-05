import type {SandboxAskCallback} from "@anthropic-ai/sandbox-runtime";
import type {NetworkAccessExecution} from "../permissions/networkAccess.js";
import type {PermissionDecision} from "../permissions/types.js";

interface Execution {
    access: NetworkAccessExecution | undefined;
    signal: AbortSignal;
    denied: Set<string>;
    diagnostics: string[];
}

/** The proxy reports host/port, not process identity. Never guess across owners. */
export class SandboxNetworkApproval {
    private readonly executions = new Set<Execution>();
    private revision = new AbortController();
    private queue: Promise<unknown> = Promise.resolve();
    private pending = 0;
    private closed = false;

    register(access: NetworkAccessExecution | undefined, signal: AbortSignal): {
        release(): void;
        networkDenials: readonly string[];
    } {
        const execution: Execution = {access, signal, denied: new Set(), diagnostics: []};
        this.invalidate();
        this.executions.add(execution);
        const abort = () => this.invalidate();
        signal.addEventListener("abort", abort, {once: true});
        return {networkDenials: execution.diagnostics, release: () => {
            signal.removeEventListener("abort", abort);
            if (this.executions.delete(execution)) this.invalidate();
        }};
    }

    private recordDenial(host: string, port: number, reason: string): void {
        const message = `${host}:${port}（${reason}）`;
        for (const execution of this.executions) {
            if (execution.diagnostics.length < 8 && !execution.diagnostics.includes(message)) {
                execution.diagnostics.push(message);
            }
        }
    }

    private invalidate(): void {
        this.revision.abort();
        this.revision = new AbortController();
    }

    private eligible(): NetworkAccessExecution | undefined {
        let selected: NetworkAccessExecution | undefined;
        if (this.closed) return undefined;
        for (const execution of this.executions) {
            const access = execution.access;
            if (execution.signal.aborted || !access || !access.canPrompt()) return undefined;
            if (selected && (access.session !== selected.session ||
                access.canUseTool !== selected.canUseTool)) return undefined;
            selected = access;
        }
        return selected;
    }

    readonly ask: SandboxAskCallback = async ({host, port}) => {
        // Defense in depth: never display control characters or accept wildcard grants.
        if (!/^[a-zA-Z0-9._:-]{1,253}$/.test(host) ||
            typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || this.pending >= 32) return false;
        host = host.toLowerCase().replace(/\.$/, "");
        const access = this.eligible();
        if (!access) {
            this.recordDenial(host, port, "无交互权限或并发执行的授权来源无法确认");
            return false;
        }
        const signal = this.revision.signal;
        const key = `${host}:${port}`;
        this.pending++;
        const operation = this.queue.then(async () => {
            if (signal.aborted || this.eligible() !== access) return false;
            if (access.session.allows(host, port)) return true;
            if ([...this.executions].some((entry) => entry.denied.has(key))) return false;
            const decision = await this.request(access, host, port, signal);
            if (signal.aborted || this.eligible() !== access) return false;
            if (decision.behavior !== "allow" || decision.updatedInput !== undefined ||
                decision.directoryScope !== undefined ||
                (decision.networkScope !== undefined && decision.networkScope !== "once" &&
                    decision.networkScope !== "session")) {
                for (const entry of this.executions) entry.denied.add(key);
                this.recordDenial(host, port, "用户未批准网络连接");
                return false;
            }
            if (decision.networkScope === "session") access.session.grant(host, port);
            return true;
        }).catch(() => false).finally(() => { this.pending--; });
        this.queue = operation;
        return operation;
    };

    private request(
        access: NetworkAccessExecution, host: string, port: number, signal: AbortSignal
    ): Promise<PermissionDecision> {
        return new Promise((resolve) => {
            const abort = () => resolve({behavior: "deny", message: "网络请求已取消"});
            signal.addEventListener("abort", abort, {once: true});
            void Promise.resolve().then(() => {
                if (signal.aborted) return {behavior: "deny" as const, message: "网络请求已取消"};
                return access.canUseTool(
                    "bash", `允许连接 ${host}:${port}？文件与进程仍受 OS Sandbox 保护。`,
                    {host, port},
                    {allowPersistent: false, presentation: {kind: "network_access", host, port}, signal}
                );
            }).then(resolve, () => resolve({behavior: "deny", message: "网络授权失败"}))
                .finally(() => signal.removeEventListener("abort", abort));
        });
    }

    close(): void {
        this.closed = true;
        this.invalidate();
        this.executions.clear();
    }
}
