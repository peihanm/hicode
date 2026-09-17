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
        const message = `${host}:${port}(${reason})`;
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
            if (execution.signal.aborted || !access) return undefined;
            if (selected && access.session !== selected.session) return undefined;
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
            this.recordDenial(host, port, "authorization_source_unknown: no active owner, cancelled execution, or concurrent Sessions; no user decision was requested");
            return false;
        }
        const signal = this.revision.signal;
        const key = `${host}:${port}`;
        this.pending++;
        const operation = this.queue.then(async () => {
            if (signal.aborted || this.eligible() !== access) return false;
            if (access.session.allows(host, port)) return true;
            if ([...this.executions].some((entry) => entry.denied.has(key))) return false;
            if ([...this.executions].some(entry => !entry.access?.canReview())) {
                this.recordDenial(host, port, "approval_unavailable: this execution cannot request new network approval; for a finite install/build, run in the foreground with timeout_ms; this is not a user denial");
                return false;
            }
            // A Session grant is shared, but a new decision reviews a specific
            // command. The proxy cannot tell which concurrent command to show.
            if ([...this.executions].some(entry => entry.access !== access)) {
                this.recordDenial(host, port, "approval_source_ambiguous: concurrent commands share a Session but the requesting command is unknown; retry the necessary command separately after they finish; no user decision was requested");
                return false;
            }
            const decision = await this.request(access, host, port, signal);
            if (signal.aborted || this.eligible() !== access) return false;
            if (decision.behavior !== "allow" || decision.answers !== undefined ||
                Object.keys(decision).some(key => !["behavior", "networkScope"].includes(key)) ||
                decision.directoryScope !== undefined ||
                (decision.networkScope !== undefined && decision.networkScope !== "once" &&
                    decision.networkScope !== "session")) {
                for (const entry of this.executions) entry.denied.add(key);
                this.recordDenial(host, port, decision.behavior === "deny" ? `approval_denied: ${decision.message.slice(0, 1000)}` : "approval_invalid: network approval returned an invalid decision");
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
            const abort = () => resolve({behavior: "deny", message: "Network request cancelled"});
            signal.addEventListener("abort", abort, {once: true});
            void Promise.resolve().then(() => {
                if (signal.aborted) return {behavior: "deny" as const, message: "Network request cancelled"};
                return access.canUseTool(
                    "bash", `Allow connection to ${host}:${port}? Files and processes remain protected by the OS Sandbox.`,
                    {host, port},
                    {allowPersistent: false, presentation: {kind: "network_access", host, port}, signal}
                );
            }).then(resolve, () => resolve({behavior: "deny", message: "Network authorization failed"}))
                .finally(() => signal.removeEventListener("abort", abort));
        });
    }

    close(): void {
        this.closed = true;
        this.invalidate();
        this.executions.clear();
    }
}
