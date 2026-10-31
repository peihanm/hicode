import type {
    PermissionDecision,
    PermissionPromptPresentation,
} from "./types.js";
import type {PermissionActor} from "./delegation.js";

export interface PermissionRequest {
    id: number;
    question: string;
    toolName: string;
    input: unknown;
    actor?: PermissionActor;
    allowAddToAllowList?: boolean;
    presentation?: PermissionPromptPresentation;
    resolve(decision: PermissionDecision): void;
}

type Listener = () => void;

export class PermissionRequests {
    private readonly listeners = new Set<Listener>();
    private current: PermissionRequest | null = null;
    private queue: PermissionRequest[] = [];
    private disposed = false;
    private nextId = 0;
    private readonly rechecks = new Map<PermissionRequest, () => Promise<boolean>>();

    request(
        toolName: string,
        question: string,
        input: unknown,
        options?: {
            allowPersistent?: boolean;
            presentation?: PermissionPromptPresentation;
            signal?: AbortSignal;
            actor?: PermissionActor;
            revalidate?: () => Promise<boolean>;
        }
    ): Promise<PermissionDecision> {
        if (this.disposed || options?.signal?.aborted) {
            return Promise.resolve({behavior: "deny", message: "Permission request cancelled"});
        }

        return new Promise<PermissionDecision>((resolve) => {
            let settled = false;
            const request: PermissionRequest = {
                id: ++this.nextId,
                question,
                toolName,
                input,
                actor: options?.actor,
                allowAddToAllowList:
                    options?.allowPersistent !== false &&
                    toolName !== "write_file" &&
                    toolName !== "edit_file" &&
                    options?.presentation?.kind !== "network_access" &&
                    !(
                        toolName === "bash" &&
                        typeof input === "object" &&
                        input !== null &&
                        "sandbox_permissions" in input &&
                        input.sandbox_permissions === "require_escalated"
                    ),
                presentation: options?.presentation,
                resolve: (decision) => {
                    if (settled) return;
                    settled = true;
                    this.rechecks.delete(request);
                    options?.signal?.removeEventListener("abort", abort);
                    resolve(decision);
                },
            };
            const abort = () => {
                request.resolve({behavior: "deny", message: "Permission request cancelled"});
                if (!this.clear(request)) {
                    this.queue = this.queue.filter((entry) => entry !== request);
                }
            };
            options?.signal?.addEventListener("abort", abort, {once: true});
            if (options?.revalidate) this.rechecks.set(request, options.revalidate);
            if (this.current) this.queue.push(request);
            else this.current = request;
            this.notify();
        });
    }

    clear(request: PermissionRequest | null): boolean {
        if (!request || this.current !== request) return false;
        this.current = this.queue.shift() ?? null;
        this.notify();
        return true;
    }

    /** Reuse new Session grants without turning an explicit ask rule into an automatic allow. */
    async reconsider(): Promise<void> {
        for (const [request, recheck] of [...this.rechecks]) {
            let allowed = false;
            try {allowed = await recheck();} catch {continue;}
            if (!allowed || !this.rechecks.has(request)) continue;
            request.resolve({behavior: "allow"});
            if (!this.clear(request)) this.queue = this.queue.filter(entry => entry !== request);
        }
    }

    denyPending(message: string, scope?: "root"): boolean {
        const requests = [...(this.current ? [this.current] : []), ...this.queue].filter(request => scope !== "root" || !request.actor);
        if (requests.length === 0) return false;
        if (this.current && requests.includes(this.current)) this.current = null;
        this.queue = this.queue.filter(request => !requests.includes(request));
        this.current ??= this.queue.shift() ?? null;
        for (const request of requests) request.resolve({behavior: "deny", message});
        this.notify();
        return true;
    }

    dispose(): void {
        this.disposed = true;
        this.denyPending("Application is shutting down");
        this.listeners.clear();
    }

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): PermissionRequest | null => this.current;

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // UI subscribers cannot stall the permission Promise.
            }
        }
    }
}
