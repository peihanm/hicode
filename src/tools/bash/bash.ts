import {z} from "zod";
import {realpath, stat} from "node:fs/promises";
import {isAbsolute, relative, resolve} from "node:path";
import type {Tool, ToolContext} from "../types.js";
import {matchPattern} from "../../permissions/index.js";
import {
    hasShellBackgroundOperator,
    isCompoundShellPattern,
    isShellCommandReadOnly,
    parseShellCommand,
    splitShellSubCommands,
} from "../../permissions/shellCommand.js";
import type {ShellExecutionResult} from "./process.js";
import type {ShellTaskSnapshot} from "../../tasks/index.js";
import {displayToolPath} from "../shared/paths.js";

const inputSchema = z.object({
    command: z.string().describe(
        "要执行的 Bash 命令，默认启用 pipefail（不启用 set -e）：管道任一段失败会保留非零状态，显式 || 可处理预期失败。长输出由工具保存并裁剪，测试不要接 head；上游 SIGPIPE 不会自动当成功。优先运行项目已有脚本/测试；curl 仅用于少量本地 API/HTML 探测，不要用临时 curl 测试矩阵代替项目测试或浏览器验证。HTTP 检查应有界等待服务 ready，并保证任一端点失败时整个命令返回非零；不要用 `|| echo FAIL` 掩盖失败。若本地监听或访问返回 Sandbox EPERM，保持原命令并用 require_escalated 重试，不要换端口、语言或重写服务。非 ASCII 文本不要用 head -c/cut -b 按字节截断；不要在末尾添加 &"
    ),
    cwd: z
        .string()
        .min(1)
        .optional()
        .describe("命令工作目录，相对当前项目目录或位于其内部的绝对路径。每次 Bash 调用相互独立；不要假设上一次 cd 会保留"),
    timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(600_000)
        .optional()
        .describe("仅用于前台命令的执行超时，单位毫秒，最大 600000；run_in_background=true 时必须省略，误传会被安全忽略"),
    run_in_background: z
        .boolean()
        .optional()
        .describe("长运行服务、GUI 或 watcher 设为 true；立即返回 task ID，之后用 bash_task 查询或停止。timeout_ms 不是启动等待时间，后台任务必须省略；任务会持续到自然退出、显式停止或 Pillar Runtime 关闭"),
    sandbox_permissions: z
        .enum(["use_default", "require_escalated"])
        .optional()
        .describe("默认在 OS Sandbox 内执行；实际网络连接由 Runtime 按域名与端口申请授权，批准后仍保留 Sandbox。直接启动 macOS .app 可执行文件时自动申请本次 elevated 授权。只有确实需要脱离 Sandbox 时才使用 require_escalated，并等待用户单独确认"),
});

type CommandCwdResult =
    | {ok: true; path: string}
    | {ok: false; message: string};

async function resolveCommandCwd(
    projectCwd: string,
    requestedCwd: string | undefined
): Promise<CommandCwdResult> {
    const candidate = resolve(projectCwd, requestedCwd ?? ".");
    try {
        const [projectRealPath, candidateRealPath, candidateStat] =
            await Promise.all([
                realpath(projectCwd),
                realpath(candidate),
                stat(candidate),
            ]);
        const rel = relative(projectRealPath, candidateRealPath);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            return {
                ok: false,
                message: `Bash cwd 必须位于当前项目目录内: ${requestedCwd}`,
            };
        }
        if (!candidateStat.isDirectory()) {
            return {ok: false, message: `Bash cwd 不是目录: ${requestedCwd}`};
        }
        return {ok: true, path: candidateRealPath};
    } catch (error) {
        return {
            ok: false,
            message: `无法使用 Bash cwd ${requestedCwd ?? "."}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

function backgroundSyntaxMessage(): string {
    return "Bash command 禁止使用 shell 后台操作符 &。启动长运行服务请单独调用 bash 并设置 run_in_background=true；重启受管任务时先用 bash_task stop。";
}

function isDirectMacOSApplicationCommand(command: string): boolean {
    const quotedExecutable = /^\s*(["'])(\/.+?\.app\/Contents\/MacOS\/.+?)\1(?:\s|$)/i;
    const unquotedExecutable = /^\s*\/\S+\.app\/Contents\/MacOS\/\S+(?:\s|$)/i;
    return splitShellSubCommands(command).some((part) =>
        quotedExecutable.test(part) || unquotedExecutable.test(part)
    );
}

function requiredHostExecutionGrant(
    command: string,
    sandboxPermissions: "use_default" | "require_escalated" | undefined,
    ctx: ToolContext
): {reason: string; command: string} | undefined {
    if (
        sandboxPermissions === "require_escalated" ||
        ctx.shellRunner.sandboxStatus.kind !== "ready" ||
        !isDirectMacOSApplicationCommand(command)
    ) return undefined;
    return {reason: "启动 macOS 应用进程", command};
}

function formatShellResult(result: ShellExecutionResult): string {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const termination = result.termination;
    if (termination.kind === "exit" && termination.code === 0) {
        return output || "(无输出)";
    }

    const status =
        termination.kind === "exit"
            ? termination.signal
                ? `signal ${termination.signal}`
                : `exit code ${termination.code}`
            : termination.kind === "timeout"
                ? `timeout ${termination.timeoutMs}ms`
                : termination.kind === "aborted"
                    ? `aborted ${termination.reason}`
                    : termination.kind === "output_limit"
                        ? `output limit ${termination.maxBuffer} bytes`
                        : "spawn error";
    const detail =
        termination.kind === "spawn_error" ? termination.error.message : output;
    const timeoutNotice = termination.kind === "timeout"
        ? "\n命令及其子进程已经终止，不会在后台继续运行。长任务请使用 run_in_background=true。"
        : "";
    return `执行失败 (${status}):\n${detail || "(无输出)"}${timeoutNotice}`;
}

function shellOutcome(result: ShellExecutionResult): "ok" | "failed" | "interrupted" {
    if (result.termination.kind === "aborted") return "interrupted";
    return result.termination.kind === "exit" && result.termination.code === 0
        ? "ok"
        : "failed";
}

function formatShellStatus(result: ShellExecutionResult): string {
    const termination = result.termination;
    if (termination.kind === "exit" && termination.code === 0) {
        return "命令执行成功（exit code 0）。";
    }
    if (termination.kind === "exit") {
        return `命令执行失败（${termination.signal ? `signal ${termination.signal}` : `exit code ${termination.code}`}）。`;
    }
    if (termination.kind === "timeout") {
        return `命令执行超时（${termination.timeoutMs}ms）；命令及其子进程已经终止，不会在后台继续运行。`;
    }
    if (termination.kind === "output_limit") return `命令输出达到安全上限（${termination.maxBuffer} bytes），结果不完整。`;
    if (termination.kind === "aborted") return `命令已取消（${termination.reason}）。`;
    return `命令启动失败：${termination.error.message}`;
}

function shellTaskTermination(task: ShellTaskSnapshot): string {
    const termination = task.termination;
    if (!termination) return task.status;
    if (termination.kind === "exit") {
        return termination.signal
            ? `signal ${termination.signal}`
            : `exit ${termination.code}`;
    }
    if (termination.kind === "timeout") return `timeout ${termination.timeoutMs}ms`;
    if (termination.kind === "aborted") return `aborted ${termination.reason}`;
    if (termination.kind === "output_limit") {
        return `output limit ${termination.maxBuffer} bytes`;
    }
    return `spawn error: ${termination.error.message}`;
}

function formatObservedBackgroundTask(task: ShellTaskSnapshot): string {
    const heading = task.status === "completed"
        ? "后台命令在启动观察期内已完成。"
        : task.status === "cancelled"
            ? "后台任务在启动观察期内已取消。"
            : "后台任务在启动观察期内已失败。";
    return [
        heading,
        `Task: ${task.id}`,
        `Status: ${task.status}`,
        `Termination: ${shellTaskTermination(task)}`,
        task.output || task.outputIssue || "(无输出)",
        ...(task.outputResult
            ? [`Full output: read_tool_result(${task.outputResult.resultId})`]
            : []),
    ].join("\n");
}

export const bashTool: Tool<typeof inputSchema> = {
    name: "bash",
    description: "在 shell 中执行系统命令、项目脚本、依赖安装、构建与测试并返回 stdout/stderr。每次调用都是独立进程，需要子目录时传 cwd，不要依赖上一条命令中的 cd。网络代理会按实际连接的域名和端口申请授权；无需为了下载依赖主动脱离 Sandbox。直接启动 macOS .app 可执行文件时，Runtime 会自动申请本次命令的 elevated 授权。已知文件内容使用 read_file，代码定位使用 grep；curl 只适合少量本地 API/HTML GET/HEAD 可达性探测，不用于替代项目测试或浏览器交互验证，且任一失败必须让整个命令返回非零。若本地监听返回 Sandbox EPERM，保持原命令并用 require_escalated 重试，不要换端口、语言或重写服务。不要用 head -c/cut -b 截断可能含非 ASCII 的响应。长运行服务、GUI 或 watcher 使用 run_in_background 并省略 timeout_ms；工具会拒绝 shell 后台操作符 &。",
    parameters: inputSchema,
    maxResultSizeChars: 30_000,
    isReadOnly: ({command, sandbox_permissions}) =>
        sandbox_permissions !== "require_escalated" &&
        isShellCommandReadOnly(command),
    isConcurrencySafe: ({command, sandbox_permissions}) =>
        sandbox_permissions !== "require_escalated" &&
        isShellCommandReadOnly(command),
    requiresUserInteraction: ({command, sandbox_permissions}, ctx) =>
        sandbox_permissions === "require_escalated" ||
        requiredHostExecutionGrant(command, sandbox_permissions, ctx) !== undefined,
    getDefaultApprovalScope: ({command, sandbox_permissions}, ctx) =>
        sandbox_permissions !== "require_escalated" &&
            requiredHostExecutionGrant(command, sandbox_permissions, ctx) === undefined &&
            ctx.shellRunner.sandboxStatus.kind === "ready"
            ? {kind: "sandboxed"}
            : undefined,
    async checkPermissions({command, cwd, sandbox_permissions}, ctx) {
        if (hasShellBackgroundOperator(command)) {
            return {behavior: "deny", message: backgroundSyntaxMessage()};
        }
        const commandCwd = await resolveCommandCwd(ctx.cwd, cwd);
        if (!commandCwd.ok) {
            return {behavior: "deny", message: commandCwd.message};
        }
        if (sandbox_permissions === "require_escalated") {
            return {
                behavior: "ask",
                message: [
                    "该命令请求脱离 OS Sandbox，在宿主环境中执行：",
                    `  ${command}`,
                    "脱离 Sandbox 后，命令及其子进程不再受文件和网络边界保护。是否继续?",
                ].join("\n"),
            };
        }
        const hostGrant = requiredHostExecutionGrant(
            command,
            sandbox_permissions,
            ctx
        );
        if (hostGrant) {
            return {
                behavior: "ask",
                allowPersistent: false,
                presentation: {
                    kind: "host_execution",
                    reason: hostGrant.reason,
                    command: hostGrant.command,
                },
                message: [
                    `检测到命令需要${hostGrant.reason}。`,
                    "批准后本次命令将脱离 OS Sandbox；命令及其子进程不再受文件和网络边界保护。",
                ].join("\n"),
            };
        }
        if (isShellCommandReadOnly(command)) {
            return {behavior: "allow"};
        }

        return {
            behavior: "ask",
            message: `即将执行命令:\n  ${command}\n是否执行?`,
        };
    },
    // 权限规则匹配器：拆子命令后按规则类型匹配。
    // deny/ask：任一子命令命中即可。
    // allow：普通单段规则必须匹配所有子命令；组合规则按顺序匹配每段。
    // 防止 "npm test && rm -rf x" 因 bash(npm:*) 被整条放行。
    async preparePermissionMatcher({command}) {
        const parsed = parseShellCommand(command);
        const subCommands = parsed.segments;
        const matches = (pattern: string, segment: (typeof subCommands)[number]) => {
            if (pattern.endsWith(":*")) {
                const prefix = parseShellCommand(pattern.slice(0, -2));
                const tokens = prefix.segments[0]?.tokens;
                return prefix.literal && prefix.segments.length === 1 && !!tokens &&
                    tokens.every((token, index) => token === segment.tokens[index]);
            }
            const canonical = segment.tokens.map(token => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(token)
                ? token : `'${token.replaceAll("'", "'\\''")}'`).join(" ");
            return matchPattern(pattern, segment.raw) || matchPattern(pattern, canonical);
        };
        return (pattern, behavior) => {
            // Unknown syntax cannot prove a content allow, nor prove that a
            // deny/ask rule is absent inside expansion or control structures.
            if (!parsed.literal) return behavior !== "allow";
            if (isCompoundShellPattern(pattern)) {
                const patternParts = splitShellSubCommands(pattern);
                return (
                    patternParts.length === subCommands.length &&
                    patternParts.every((part, index) =>
                        matches(part, subCommands[index]!)
                    )
                );
            }
            if (behavior === "allow") {
                return (
                    subCommands.length > 0 &&
                    subCommands.every((cmd) => matches(pattern, cmd))
                );
            }
            return subCommands.some((cmd) => matches(pattern, cmd));
        };
    },
    execute: async ({
                        command,
                        cwd,
                        timeout_ms,
                        run_in_background,
                        sandbox_permissions,
                    }, ctx, invocation) => {
        if (hasShellBackgroundOperator(command)) {
            return {
                content: backgroundSyntaxMessage(),
                outcome: "failed" as const,
            };
        }
        const resolvedCwd = await resolveCommandCwd(ctx.cwd, cwd);
        if (!resolvedCwd.ok) {
            return {content: resolvedCwd.message, outcome: "failed" as const};
        }
        const commandCwd = resolvedCwd.path;
        const hostGrant = requiredHostExecutionGrant(
            command,
            sandbox_permissions,
            ctx
        );
        const effectiveSandboxPermissions = hostGrant
            ? "require_escalated" as const
            : sandbox_permissions;
        const networkAccess = ctx.networkAccess ? {
            session: ctx.networkAccess,
            canUseTool: ctx.canUseTool,
            canPrompt: () => ctx.permissionPromptPolicy === "onRequest",
        } : undefined;
        if (run_in_background) {
            if (
                effectiveSandboxPermissions !== "require_escalated" &&
                ctx.shellRunner.sandboxStatus.kind === "unavailable"
            ) {
                return {
                    content: `Sandbox 不可用，后台命令未启动：${ctx.shellRunner.sandboxStatus.reason}`,
                    outcome: "failed" as const,
                };
            }
            if (!ctx.tasks) {
                return {
                    content: "当前 Runtime 不支持后台 Bash 任务",
                    outcome: "failed" as const,
                };
            }
            try {
                const duplicate = (await ctx.tasks.list()).find(
                    (task) =>
                        task.kind === "shell" &&
                        task.status === "running" &&
                        task.command === command &&
                        task.cwd === commandCwd
                );
                if (duplicate) {
                    return {
                        content:
                            `相同后台命令已在此目录运行。Task: ${duplicate.id}\n` +
                            "请先用 bash_task status 查询；确需重启时先用 bash_task stop，不要重复启动或按端口杀进程。",
                        outcome: "failed" as const,
                    };
                }
                const task = await ctx.tasks.startShell({
                    command,
                    cwd: commandCwd,
                    toolCallId: invocation.toolCallId,
                    maxOutputBytes: ctx.toolResultStore.maxArtifactBytes,
                    sandboxPermissions: effectiveSandboxPermissions,
                    writableRoots: ctx.directoryAccess.listDirectories(),
                    networkAccess,
                });
                if (task.status !== "running") {
                    return {
                        content: formatObservedBackgroundTask(task),
                        outcome: task.status === "completed"
                            ? "ok" as const
                            : task.status === "cancelled"
                                ? "interrupted" as const
                                : "failed" as const,
                    };
                }
                return {
                    content: [
                        `后台任务已启动。`,
                        `Task: ${task.id}`,
                        `Status: ${task.status}`,
                        `Cwd: ${displayToolPath(ctx.cwd, commandCwd) || "."}`,
                        ...(timeout_ms !== undefined
                            ? ["已忽略 timeout_ms：后台任务不会使用前台执行超时。"]
                            : []),
                        "Lifecycle: 由当前 Pillar Runtime 管理；退出 Pillar 后会终止。",
                        "使用 bash_task 查询输出、完成状态或停止任务。",
                    ].join("\n"),
                    outcome: "ok" as const,
                };
            } catch (error) {
                return {
                    content: `后台任务启动失败: ${error instanceof Error ? error.message : String(error)}`,
                    outcome: "failed" as const,
                };
            }
        }
        const capturePath = await ctx.toolResultStore.createCapture();
        try {
            const result = await ctx.shellRunner.run({
                command,
                cwd: commandCwd,
                signal: ctx.signal,
                ...(timeout_ms !== undefined ? {timeoutMs: timeout_ms} : {}),
                outputFilePath: capturePath,
                maxOutputBytes: ctx.toolResultStore.maxArtifactBytes,
                previewChars: 30_000,
                sandboxPermissions: effectiveSandboxPermissions,
                writableRoots: ctx.directoryAccess.listDirectories(),
                networkAccess,
            });
            const shouldPersist =
                (result.outputBytes ?? 0) > 30_000 ||
                result.outputComplete === false;
            if (!shouldPersist || result.termination.kind === "aborted") {
                return {
                    content: formatShellResult(result),
                    outcome: shellOutcome(result),
                };
            }
            try {
                const persisted = await ctx.toolResultStore.promoteFile({
                    toolCallId: invocation.toolCallId,
                    toolName: "bash",
                    sourcePath: capturePath,
                    originalByteLength: result.outputBytes,
                    complete: result.outputComplete,
                });
                return {
                    content: formatShellStatus(result),
                    displayContent: `${formatShellStatus(result)}\n${persisted.preview}`,
                    persisted,
                    outcome: shellOutcome(result),
                };
            } catch (error) {
                return {
                    content: `${formatShellResult(result)}\n\n完整输出保存失败：${error instanceof Error ? error.message : String(error)}`,
                    outcome: shellOutcome(result),
                };
            }
        } finally {
            await ctx.toolResultStore.removeTemporaryFile(capturePath);
        }
    },
};
