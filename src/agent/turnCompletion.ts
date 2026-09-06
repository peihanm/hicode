import {toolFileChanges} from "../fileChanges/index.js";
import type {ToolCallOutcome} from "./toolBatch.js";
import type {QueuedAgentInput} from "./inputChannel.js";
import type {Todo} from "../todos.js";
import {createHash} from "node:crypto";
import {isAbsolute, relative, resolve} from "node:path";
import {isShellCommandReadOnly, parseShellCommand} from "../permissions/shellCommand.js";
import type {ShellExecutionEvidence} from "../toolResults/types.js";

interface FailedToolRecord {
    toolCallId: string;
    name: string;
    result: string;
    executionId?: string;
}

interface CheckEvidence {
    execution: ShellExecutionEvidence;
    revision: number;
    invalidatedAt?: number;
}

export interface TurnCompletionState {
    failedTools: Map<string, FailedToolRecord>;
    activeBackgroundShells: Map<string, {taskId: string; command: string}>;
    implementationWrites: number;
    projectChecks: Map<string, CheckEvidence>;
    revision: number;
}

export function createTurnCompletionState(): TurnCompletionState {
    return {
        failedTools: new Map(),
        activeBackgroundShells: new Map(),
        implementationWrites: 0,
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

export function recordRuntimeInputs(
    state: TurnCompletionState,
    inputs: readonly QueuedAgentInput[]
): void {
    for (const input of inputs) {
        if (input.source !== "task_notification") continue;
        if (input.taskId) state.activeBackgroundShells.delete(input.taskId);
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
        if (executionId && outcome.outcome === "ok" && !outcome.untrackedWorkspaceEffects) {
            for (const [id, failure] of state.failedTools) {
                if (failure.executionId === executionId) state.failedTools.delete(id);
            }
        }
        if (outcome.outcome === "failed") {
            state.failedTools.set(outcome.toolCallId, {
                toolCallId: outcome.toolCallId,
                name: outcome.name,
                result: sanitizeEvidence(outcome.result),
                ...(executionId ? {executionId} : {}),
            });
        }
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
        if (outcome.outcome === "ok") {
            if (
                outcome.name === "write_file" ||
                outcome.name === "edit_file" ||
                outcome.name === "delete_file"
            ) {
                state.implementationWrites += 1;
            }
        }
        if (
            outcome.name === "bash" &&
            outcome.outcome === "ok" &&
            args.run_in_background === true
        ) {
            invalidateChecks(state);
            const taskId = outcome.result.match(/(?:^|\n)Task:\s*([^\s]+)/)?.[1];
            if (taskId) {
                state.activeBackgroundShells.set(taskId, {
                    taskId,
                    command: typeof args.command === "string"
                        ? args.command
                        : "background shell",
                });
            }
        }
        if (outcome.name === "bash_task") {
            const taskId = typeof args.task_id === "string"
                ? args.task_id
                : undefined;
            if (
                taskId &&
                /(?:^|\n)Status:\s*(?:completed|failed|cancelled)(?:\n|$)/.test(
                    outcome.result
                )
            ) {
                state.activeBackgroundShells.delete(taskId);
            }
        }
    }
}

/** Turn evidence is transient context, never a second persistent workspace state. */
export function formatCompletionContext(state: TurnCompletionState, todos: readonly Todo[] = []): string | undefined {
    const lines = [
        ...[...state.failedTools.values()].map(failure => `- 未解决 ${failure.name} (${failure.toolCallId}): ${failure.result}`),
        ...[...state.projectChecks.values()].map(check => `- ${check.invalidatedAt === undefined ? "检查通过" : "检查已过期（之后有相关修改）"}: ${check.execution.cwd}: ${check.execution.command.slice(0, 240)} [本轮观察版本 ${check.revision}]`),
        ...[...state.activeBackgroundShells.values()].map(task => `- 后台任务 ${task.taskId} 由当前 Pillar Runtime 管理，退出 Pillar 后终止。`),
        ...todos.filter(todo => todo.status === "in_progress").map(todo => `- Todo 尚在进行: ${todo.content}`),
    ];
    if (!lines.length) return undefined;
    return ["<system-reminder>", "当前完成证据（仅本轮实际观察；不是外部改动或完整工作区验证）：",
        ...lines.slice(0, 30).map(sanitizeEvidence),
        ...(lines.length > 30 ? [`另有 ${lines.length - 30} 条证据未展开。`] : []),
        "结束前解决失败、重跑已过期的相关检查，或准确披露限制；不要宣称未检查的目标已通过。Todo 结束前应更新状态。",
        "</system-reminder>"].join("\n");
}

function disclosesBackgroundLifecycle(text: string): boolean {
    return (
        /退出\s*Pillar[^。\n]*(?:终止|停止|关闭)/i.test(text) ||
        /Pillar[^。\n]*(?:退出|关闭)[^。\n]*(?:终止|停止)/i.test(text) ||
        /当前\s*Pillar\s*Runtime[^。\n]*(?:管理|终止|停止)/i.test(text)
    );
}

function relevantSentences(text: string): string[] {
    return text.split(/[。！？\n]+/).map((line) => line.trim()).filter(Boolean);
}

function claimsSandboxedExecution(text: string): boolean {
    return relevantSentences(text).some((sentence) =>
        /(?:沙箱|sandbox).{0,16}(?:执行|运行)|(?:执行|运行).{0,16}(?:沙箱|sandbox)/i.test(
            sentence
        ) &&
        !/(?:不是|并非|不能|不得|未|没有).{0,16}(?:沙箱|sandbox)|(?:沙箱|sandbox).{0,16}(?:不可用|未启用|不存在)/i.test(
            sentence
        )
    );
}

export function formatCompletionReminder(
    state: TurnCompletionState,
    candidateReply: string,
    todos: readonly Todo[] = []
): string | undefined {
    const lines = [...state.failedTools.values()].map(
        (failure) =>
            `- ${failure.name} (${failure.toolCallId}): ${failure.result}`
    );
    const activeShells = [...state.activeBackgroundShells.values()];
    const missingLifecycleDisclosure =
        activeShells.length > 0 && !disclosesBackgroundLifecycle(candidateReply);
    const unsupportedSandboxClaim =
        state.implementationWrites > 0 && claimsSandboxedExecution(candidateReply);
    const inProgressTodos = todos.filter((todo) => todo.status === "in_progress");
    const staleChecks = [...state.projectChecks.values()].filter(check => check.invalidatedAt !== undefined);
    const staleValidationClaim = staleChecks.length > 0 && /(?:检查|测试|验证|构建).{0,16}(?:通过|成功|正常)/.test(candidateReply) &&
        !/(?:未重跑|未重新|过期|修改后未|尚未验证)/.test(candidateReply);
    if (
        lines.length === 0 &&
        !missingLifecycleDisclosure &&
        !unsupportedSandboxClaim &&
        inProgressTodos.length === 0 && !staleValidationClaim
    ) return undefined;

    return [
        "<system-reminder>",
        ...(staleValidationClaim ? ["已有检查通过后发生了相关修改，不能将旧结果当作最终版本验证。请重跑或明确披露修改后未重跑。"] : []),
        ...(lines.length > 0
            ? [
                "本轮存在失败工具记录：",
                ...lines,
                "失败记录不一定仍代表当前状态。结束前请根据后续实际证据判断它是否已被替代；若已替代，说明验证证据；若未解决，继续修复或明确披露限制。",
            ]
            : []),
        ...(missingLifecycleDisclosure
            ? [
                "本轮仍有由 Pillar Runtime 管理的后台 Shell：",
                ...activeShells.map(
                    (task) => `- ${task.taskId}: ${task.command.slice(0, 240)}`
                ),
                "最终回答必须明确说明：这些服务只在当前 Pillar Runtime 内运行，退出 Pillar 后会终止。不要暗示它们会在会话外持续运行。",
            ]
            : []),
        ...(unsupportedSandboxClaim
            ? [
                "候选回答声称实现了沙箱执行，但本轮文件修改和普通命令证据不能证明生成的应用具备真实隔离。临时目录、子进程和 timeout 都不是沙箱；除非确实实现并验证了容器、虚拟机、受限 OS 用户或同等级隔离，否则必须改称本机子进程执行并披露文件、网络、凭证和资源风险。",
            ]
            : []),
        ...(inProgressTodos.length > 0
            ? [
                "当前 Session 仍有标记为 in_progress 的 Todo：",
                ...inProgressTodos.map((todo) => `- ${todo.content}`),
                "本轮结束后不会再有工作实际执行，因此不能保留『正在进行』状态。若任务已经完成，先调用 todo_write 标记 completed；若尚未完成则继续执行；若决定暂缓，改为 pending 并在最终回答中准确说明。不要直接提交最终回答。",
            ]
            : []),
        "上一版候选回答如下：",
        "<candidate-reply>",
        sanitizeCandidateReply(candidateReply),
        "</candidate-reply>",
        "请保留候选回答中的有效信息，在其基础上修正上面的缺失；不要缩减成只补充一条说明，也不要仅重复完成声明。",
        "</system-reminder>",
    ].join("\n");
}
