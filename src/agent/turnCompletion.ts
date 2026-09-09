import {toolFileChanges} from "../fileChanges/index.js";
import type {ToolCallOutcome} from "./toolBatch.js";
import type {Todo} from "../todos.js";
import {createHash} from "node:crypto";
import {isAbsolute, relative, resolve} from "node:path";
import {isShellCommandReadOnly, parseShellCommand} from "../permissions/shellCommand.js";
import type {ShellExecutionEvidence} from "../toolResults/types.js";

interface CheckEvidence {
    execution: ShellExecutionEvidence;
    revision: number;
    invalidatedAt?: number;
}

export interface TurnCompletionState {
    projectChecks: Map<string, CheckEvidence>;
    revision: number;
}

export function createTurnCompletionState(): TurnCompletionState {
    return {
        projectChecks: new Map(),
        revision: 0,
    };
}

function sanitizeEvidence(result: string): string {
    return result
        .replace(/<\/?system-reminder>/gi, "[system-reminder tag removed]")
        .slice(0, 2_000);
}

function sanitizeCandidateReply(reply: string): string {
    return reply
        .replace(/<\/?(?:system-reminder|candidate-reply)>/gi, "[reserved tag removed]")
        .slice(0, 8_000);
}

function parseArgs(argsJson: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(argsJson) as unknown;
        return parsed && typeof parsed === "object"
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function isProjectCheck(command: string): boolean {
    const parsed = parseShellCommand(command);
    if (!parsed.literal || parsed.segments.length !== 1) return false;
    const tokens = parsed.segments[0]!.tokens;
    if (tokens[0] === "node") {
        return tokens[1] === "--test" && !tokens.slice(2).some(token =>
            ["--help", "-h", "--version", "-v", "--watch"].includes(token));
    }
    const check = (tokens: readonly string[]) => /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|verify|typecheck|build)\b|(?:pytest|python\s+-m\s+pytest|vitest|jest|cargo\s+test|go\s+test)\b)/i.test(tokens.join(" "));
    return check(tokens);
}

function within(directory: string, path: string): boolean {
    const part = relative(directory, path);
    return part === "" || (part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part));
}

function executionIdentity(execution: ShellExecutionEvidence): string {
    return createHash("sha256").update(JSON.stringify([execution.cwd, execution.command.trim(), execution.sandboxPermissions])).digest("hex");
}

function invalidateChecks(state: TurnCompletionState, path?: string, directory = false): void {
    state.revision++;
    for (const evidence of state.projectChecks.values()) {
        if (!path || within(evidence.execution.cwd, path) || (directory && within(path, evidence.execution.cwd))) {
            evidence.invalidatedAt = state.revision;
        }
    }
}

export function recordToolOutcomes(
    state: TurnCompletionState,
    outcomes: readonly ToolCallOutcome[],
    cwd: string
): void {
    for (const outcome of outcomes) {
        const execution = outcome.name === "bash" ? outcome.shellExecution : undefined;
        const executionId = execution ? executionIdentity(execution) : undefined;
        for (const change of toolFileChanges(outcome.uiData)) invalidateChecks(state, resolve(cwd, change.path));
        const projectCheck = execution && isProjectCheck(execution.command);
        if (execution && !isShellCommandReadOnly(execution.command) && !projectCheck) {
            invalidateChecks(state, execution.cwd, true);
        }
        if (projectCheck && executionId) {
            if (outcome.outcome === "ok") {
                state.projectChecks.set(executionId, {execution, revision: state.revision});
            } else {
                state.projectChecks.delete(executionId);
            }
        }
        if (outcome.untrackedWorkspaceEffects) invalidateChecks(state);
        const args = parseArgs(outcome.argsJson);
        if (
            outcome.name === "bash" &&
            outcome.outcome === "ok" &&
            args.run_in_background === true
        ) {
            invalidateChecks(state);
        }
    }
}

/** Turn evidence is transient context, never a second persistent workspace state. */
export function formatCompletionContext(state: TurnCompletionState): string | undefined {
    const lines = [
        ...[...state.projectChecks.values()].map(check => `- ${check.invalidatedAt === undefined ? "检查通过" : "检查已过期（之后有相关修改）"}: ${check.execution.cwd}: ${check.execution.command.slice(0, 240)} [本轮观察版本 ${check.revision}]`),
    ];
    if (!lines.length) return undefined;
    return ["<system-reminder>", "当前完成证据（仅本轮实际观察；不是外部改动或完整工作区验证）：",
        ...lines.slice(0, 30).map(sanitizeEvidence),
        ...(lines.length > 30 ? [`另有 ${lines.length - 30} 条证据未展开。`] : []),
        "根据实际结果判断是否需要重跑已过期的相关检查，或准确披露限制；不要宣称未检查的目标已通过。",
        "</system-reminder>"].join("\n");
}

/** Only structured Todo state can request this bounded final-answer nudge. */
export function formatTodoCompletionReminder(
    candidateReply: string,
    todos: readonly Todo[]
): string | undefined {
    const inProgressTodos = todos.filter((todo) => todo.status === "in_progress");
    if (inProgressTodos.length === 0) return undefined;

    return [
        "<system-reminder>",
        "当前 Session 仍有标记为 in_progress 的 Todo：",
        ...inProgressTodos.map((todo) => `- ${todo.content}`),
        "本轮结束后不会再有工作实际执行，因此不能保留『正在进行』状态。若任务已经完成，先调用 todo_write 标记 completed；若尚未完成则继续执行；若决定暂缓，改为 pending 并在最终回答中准确说明。不要直接提交最终回答。",
        "上一版候选回答如下：",
        "<candidate-reply>",
        sanitizeCandidateReply(candidateReply),
        "</candidate-reply>",
        "请保留候选回答中的有效信息，在其基础上修正上面的缺失；不要缩减成只补充一条说明，也不要仅重复完成声明。",
        "</system-reminder>",
    ].join("\n");
}
