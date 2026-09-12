import type {
    PermissionDecision,
    PermissionPromptPresentation,
} from "../../permissions/index.js";
import type {ConfirmReq} from "./types.js";

type Listener = () => void;

export class UIPermissionRequests {
    private readonly listeners = new Set<Listener>();
    private current: ConfirmReq | null = null;
    private queue: ConfirmReq[] = [];
    private disposed = false;
    private nextId = 0;

    request(
        toolName: string,
        question: string,
        input: unknown,
        options?: {
            allowPersistent?: boolean;
            presentation?: PermissionPromptPresentation;
            signal?: AbortSignal;
        }
    ): Promise<PermissionDecision> {
        if (this.disposed || options?.signal?.aborted) {
            return Promise.resolve({behavior: "deny", message: "Permission request cancelled"});
        }

        return new Promise<PermissionDecision>((resolve) => {
            let settled = false;
            const request: ConfirmReq = {
                id: ++this.nextId,
                question,
                toolName,
                input,
                allowAddToAllowList:
                    options?.allowPersistent !== false &&
                    toolName !== "write_file" &&
                    toolName !== "edit_file" &&
                    toolName !== "delete_file" &&
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
            if (this.current) this.queue.push(request);
            else this.current = request;
            this.notify();
        });
    }

    clear(request: ConfirmReq | null): boolean {
        if (!request || this.current !== request) return false;
        this.current = this.queue.shift() ?? null;
        this.notify();
        return true;
    }

    denyPending(message: string): boolean {
        const requests = [...(this.current ? [this.current] : []), ...this.queue];
        if (requests.length === 0) return false;
        this.current = null;
        this.queue = [];
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

    getSnapshot = (): ConfirmReq | null => this.current;

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
