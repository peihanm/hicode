import type {PermissionDecision} from "../../permissions/index.js";
import type {ConfirmReq} from "./types.js";

type Listener = () => void;

export class UIPermissionRequests {
    private readonly listeners = new Set<Listener>();
    private current: ConfirmReq | null = null;

    request(
        toolName: string,
        question: string,
        input: unknown
    ): Promise<PermissionDecision> {
        if (this.current) {
            return Promise.reject(new Error("已有权限请求正在等待处理"));
        }

        return new Promise<PermissionDecision>((resolve) => {
            let settled = false;
            const request: ConfirmReq = {
                question,
                toolName,
                input,
                allowAddToAllowList:
                    toolName !== "enter_plan_mode" &&
                    toolName !== "exit_plan_mode" &&
                    !(
                        toolName === "bash" &&
                        typeof input === "object" &&
                        input !== null &&
                        "sandbox_permissions" in input &&
                        input.sandbox_permissions === "require_escalated"
                    ),
                resolve: (decision) => {
                    if (settled) return;
                    settled = true;
                    resolve(decision);
                },
            };
            this.current = request;
            this.notify();
        });
    }

    clear(request: ConfirmReq | null): boolean {
        if (!request || this.current !== request) return false;
        this.current = null;
        this.notify();
        return true;
    }

    denyPending(message: string): boolean {
        const request = this.current;
        if (!request) return false;
        this.current = null;
        request.resolve({behavior: "deny", message});
        this.notify();
        return true;
    }

    dispose(): void {
        this.denyPending("应用正在关闭");
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
                // UI subscriber 不能卡住权限 Promise。
            }
        }
    }
}
