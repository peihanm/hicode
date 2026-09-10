import {randomUUID} from "node:crypto";
import type {Message} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import type {PermissionDecision, PermissionPromptPresentation} from "./types.js";

export interface ApprovalRequest {
    id: string;
    kind: "tool" | "file" | "exec" | "network";
    sessionId: string;
    turnId: string;
    toolCallId: string;
    toolName: string;
    cwd: string;
    input: unknown;
    reason: string;
    presentation?: PermissionPromptPresentation;
    evidence: readonly Message[];
}

export interface ReviewVerdict {
    decision: "allow" | "deny" | "needs_user";
    risk: "low" | "medium" | "high";
    reason: string;
}

export type ApprovalReviewer = (request: ApprovalRequest, context: ToolContext, signal: AbortSignal) => Promise<ReviewVerdict>;
export type ApprovalSource = "user" | "auto-review" | "preauthorized";
export interface ApprovalResolution {
    decision: PermissionDecision;
    source: ApprovalSource;
    code?: "policy_denied" | "approval_required" | "review_failed";
}

export interface ApprovalEvent {
    type: "approval_review";
    phase: "start" | "end";
    requestId: string;
    turnId: string;
    toolCallId: string;
    source: ApprovalSource;
    outcome?: "allow" | "deny" | "needs_user" | "error";
    reason?: string;
    code?: "policy_denied" | "approval_required" | "review_failed";
}

/** One Session epoch invalidates pending decisions; it is not a second copy of policy. */
export class ApprovalEpoch {
    private controller = new AbortController();
    get signal(): AbortSignal { return this.controller.signal; }
    invalidate(): void {
        this.controller.abort("approval-policy-changed");
        this.controller = new AbortController();
    }
}

/** Turn-owned review concurrency and denial budget. No cross-turn authorization cache. */
export class ApprovalBudget {
    private active = 0;
    private readonly queue: Array<() => void> = [];
    private consecutiveDenials = 0;
    private consecutiveFailures = 0;
    private readonly recent: boolean[] = [];
    private stoppedFor: "denied" | "failed" | undefined;
    get stopped(): boolean { return this.stoppedFor !== undefined; }
    get stopMessage(): string {
        return this.stoppedFor === "failed"
            ? "自动审核连续未完成，已停止执行；请检查审核服务或由 Host 提供决定"
            : "自动审核连续拒绝，已停止执行；请确认被拒绝的操作和授权范围";
    }

    async acquire(signal: AbortSignal): Promise<() => void> {
        signal.throwIfAborted();
        if (this.stopped) throw new Error(this.stopMessage);
        if (this.active >= 2) {
            if (this.queue.length >= 16) throw new Error("自动审核队列已满");
            await new Promise<void>((resolve, reject) => {
                const start = () => { signal.removeEventListener("abort", abort); resolve(); };
                const abort = () => {
                    const index = this.queue.indexOf(start);
                    if (index >= 0) this.queue.splice(index, 1);
                    reject(new Error("审核排队已取消"));
                };
                this.queue.push(start);
                signal.addEventListener("abort", abort, {once: true});
            });
        } else this.active++;
        return () => {
            const next = this.queue.shift();
            if (next) next(); else this.active--;
        };
    }

    record(denied: boolean): void {
        this.consecutiveFailures = 0;
        this.consecutiveDenials = denied ? this.consecutiveDenials + 1 : 0;
        this.recent.push(denied);
        if (this.recent.length > 50) this.recent.shift();
        if (!this.stopped && (this.consecutiveDenials >= 3 || this.recent.filter(Boolean).length >= 10)) this.stoppedFor = "denied";
    }

    recordFailure(): void {
        if (++this.consecutiveFailures >= 3 && !this.stopped) this.stoppedFor = "failed";
    }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("审核已取消或超时"));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, {once: true});
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

export async function requestApproval(
    ctx: ToolContext,
    toolName: string,
    input: unknown,
    reason: string,
    toolCallId: string,
    options: {allowPersistent?: boolean; presentation?: PermissionPromptPresentation; signal?: AbortSignal} = {}
): Promise<ApprovalResolution> {
    const epoch = ctx.approvalEpoch.signal;
    const signal = AbortSignal.any([options.signal ?? ctx.signal, epoch]);
    const mode = ctx.permissionMode;
    const requestId = randomUUID();
    const human = async (code: "approval_required" | "review_failed", message: string): Promise<ApprovalResolution> => {
        if (ctx.permissionPromptPolicy === "never") {
            await ctx.onApprovalEvent?.({type: "approval_review", phase: "end", requestId, turnId: ctx.turnId, toolCallId,
                source: "user", outcome: "needs_user", code, reason: message.slice(0, 4000)});
            return {source: "user", code, decision: {behavior: "deny", message: `[${code}] 当前 Host 不支持权限交互：${message}`}};
        }
        const decision = await withAbort(ctx.canUseTool(toolName, message, structuredClone(input), {...options, signal}), signal);
        signal.throwIfAborted();
        if (decision.behavior === "allow") ctx.approvalBudget.record(false);
        return {source: "user", decision};
    };
    if (toolName === "ask_user") return human("approval_required", reason);
    if (mode === "full-access" && ctx.allowFullAccess) return {source: "preauthorized", decision: {behavior: "allow"}};
    if (mode !== "auto-review") return human("approval_required", reason);
    const request: ApprovalRequest = {
        id: requestId, kind: options.presentation?.kind === "network_access" ? "network"
            : toolName === "bash" ? "exec" : options.presentation?.kind === "filesystem_access" ? "file" : "tool",
        sessionId: ctx.sessionId, turnId: ctx.turnId, toolCallId, toolName, cwd: ctx.cwd,
        input: structuredClone(input), reason, presentation: options.presentation,
        evidence: structuredClone(ctx.approvalEvidence?.() ?? []),
    };
    const emit = async (event: Omit<ApprovalEvent, "type" | "requestId" | "turnId" | "toolCallId" | "source">) => {
        await ctx.onApprovalEvent?.({type: "approval_review", requestId: request.id, turnId: ctx.turnId, toolCallId, source: "auto-review", ...event});
    };
    let release: (() => void) | undefined;
    let verdict: ReviewVerdict;
    try {
        release = await ctx.approvalBudget.acquire(signal);
        signal.throwIfAborted();
        await emit({phase: "start"});
        if (!ctx.approvalReviewer) throw new Error("当前 Runtime 没有自动审核能力");
        const timeout = AbortSignal.timeout(60_000);
        const reviewSignal = AbortSignal.any([signal, timeout]);
        verdict = await withAbort(ctx.approvalReviewer(request, ctx, reviewSignal), reviewSignal);
        signal.throwIfAborted();
        ctx.approvalBudget.record(verdict.decision === "deny");
        await emit({phase: "end", outcome: verdict.decision, reason: verdict.reason,
            ...(verdict.decision === "deny" ? {code: "policy_denied" as const} : verdict.decision === "needs_user" ? {code: "approval_required" as const} : {})});
    } catch (error) {
        if (signal.aborted) throw error;
        ctx.approvalBudget.recordFailure();
        const message = `自动审核未完成：${error instanceof Error ? error.message : String(error)}`;
        await emit({phase: "end", outcome: "error", reason: message, code: "review_failed"});
        return human("review_failed", message);
    } finally { release?.(); }
    if (verdict.decision === "needs_user") return human("approval_required", verdict.reason);
    return verdict.decision === "allow" ? {source: "auto-review", decision: {behavior: "allow"}}
        : {source: "auto-review", code: "policy_denied", decision: {behavior: "deny",
            message: `${verdict.reason}。不得换工具或改写命令绕过；只能采用实质更安全的方案或向用户说明。`}};
}
