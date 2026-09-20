import {z} from "zod";
import {ApprovalBudget, ApprovalEpoch, requestApproval} from "../../permissions/approval.js";
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
import {selectUtf8Range} from "../../toolResults/utf8.js";
import {prepareCommandReadAccess} from "./readAccess.js";
import {analyzeReadCommand} from "../../permissions/shellRead.js";

const inputSchema = z.object({
    command: z.string().describe(
        "Shell command. pipefail is enabled (not set -e); failed pipeline stages retain a nonzero status. Handle expected failures explicitly without masking them. Do not pipe tests to head, assume SIGPIPE is success, byte-truncate non-ASCII output, or append &."
    ),
    cwd: z
        .string()
        .min(1)
        .optional()
        .describe("Working directory, relative to the current project or an absolute path permitted by runtime policy. Each call is independent; previous cd state is not retained."),
    timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(600_000)
        .optional()
        .describe("Execution timeout in milliseconds, maximum 600000; foreground default is 30000. Set a sufficient timeout for finite installs/builds/tests instead of using a shell timeout utility. Foreground and yielded commands terminate on expiry. Omit with run_in_background=true; an accidental value is ignored safely."),
    run_in_background: z
        .boolean()
        .optional()
        .describe("For services, GUIs and watchers. Returns a task ID immediately; use task to inspect/stop. Omit timeout_ms. Runs until exit, explicit stop or Runtime shutdown. In Ask mode background tasks can use existing Session network grants but cannot request new ones; run installs in the foreground when approval may be needed."),
    yield_time_ms: z.number().int().min(100).max(30_000).optional()
        .describe("Wait 100-30000ms; return final output if done, otherwise a Task ID while the same process continues. Requires a host supporting background tasks. timeout_ms still caps total execution; omitting it leaves no timeout. In Ask mode this invocation cannot request new network approvals, even before yielding. Do not combine with run_in_background=true."),
    sandbox_permissions: z
        .enum(["use_default", "require_escalated"])
        .optional()
        .describe("use_default follows the runtime sandbox policy; network access is authorized by domain/port without inherently leaving the sandbox. Use require_escalated only when leaving the sandbox is necessary; it has a separate authorization boundary."),
});

type CommandCwdResult =
    | {ok: true; path: string}
    | {ok: false; message: string};

async function resolveCommandCwd(
    projectCwd: string,
    requestedCwd: string | undefined,
    fullAccess = false
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
        if (!fullAccess && (rel.startsWith("..") || isAbsolute(rel))) {
            return {
                ok: false,
                message: `Bash cwd must be inside the current project: ${requestedCwd}`,
            };
        }
        if (!candidateStat.isDirectory()) {
            return {ok: false, message: `Bash cwd is not a directory: ${requestedCwd}`};
        }
        return {ok: true, path: candidateRealPath};
    } catch (error) {
        return {
            ok: false,
            message: `Cannot use Bash cwd ${requestedCwd ?? "."}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

function backgroundSyntaxMessage(): string {
    return "Bash command cannot contain shell background operator &. Start a long-running service in a separate bash call with run_in_background=true; use task stop before restarting a managed task.";
}

function runningOutput(task: ShellTaskSnapshot): string {
    if (!task.output) return task.outputIssue
        ? `Output unavailable: ${task.outputIssue}`
        : "No output captured yet. Use task status to check readiness and the actual address before probing a service; do not assume its default port.";
    const bytes = Buffer.from(task.output, "utf8");
    const limit = 4000;
    const start = Math.max(0, bytes.length - limit);
    const preview = selectUtf8Range(bytes.subarray(start), limit).content.toString("utf8");
    return `Captured output (not a readiness check):\n${start ? "[Earlier output omitted; use task status for more]\n" : ""}${preview}`;
}

function formatShellResult(result: ShellExecutionResult, noMatches = false): string {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const termination = result.termination;
    if (noMatches) return "No matches found (rg exit code 1).";
    if (termination.kind === "exit" && termination.code === 0) {
        return output || "(no output)";
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
        ? "\nThe command and its child processes have terminated; they will not continue in the background. Check partial effects before retrying. For a finite install, build or test, set a longer timeout_ms (maximum 600000). Use run_in_background=true only for persistent services/watchers; in Ask mode background and yielded commands cannot request new network approval."
        : "";
    return `Execution failed (${status}):\n${detail || "(no output)"}${timeoutNotice}`;
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
        return "Command succeeded (exit code 0).";
    }
    if (termination.kind === "exit") {
        return `Command failed (${termination.signal ? `signal ${termination.signal}` : `exit code ${termination.code}`}).`;
    }
    if (termination.kind === "timeout") {
        return `Command timed out (${termination.timeoutMs} ms); the command and its children terminated and will not continue in the background.`;
    }
    if (termination.kind === "output_limit") return `Command output reached the safety limit (${termination.maxBuffer} bytes); results are incomplete.`;
    if (termination.kind === "aborted") return `Command cancelled (${termination.reason}).`;
    return `Command failed to start: ${termination.error.message}`;
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

function formatObservedBackgroundTask(task: ShellTaskSnapshot, yielded = false): string {
    const heading = task.status === "completed"
        ? "Background command completed during the startup observation window."
        : task.status === "cancelled"
            ? "Background task was cancelled during the startup observation window."
            : "Background task failed during the startup observation window.";
    return [
        yielded ? `Command ended: ${task.status}.` : heading,
        `Task: ${task.id}`,
        `Status: ${task.status}`,
        `Termination: ${shellTaskTermination(task)}`,
        task.output || task.outputIssue || "(no output)",
        ...(task.outputResult
            ? [`Saved output: ${JSON.stringify(task.outputResult.path)}`]
            : []),
    ].join("\n");
}

export const bashTool: Tool<typeof inputSchema> = {
    name: "bash",
    description: `Run shell commands, project scripts, dependencies, builds and tests; return stdout/stderr. Use dedicated tools for file reading, editing and search.
- Use $TMPDIR for temporary files and clean up only artifacts you created; directory grants and explicit denials still apply.
- Each call is a separate process: pass cwd rather than relying on a previous cd. Run tests/builds directly; the runtime preserves and budgets output. Do not add tail/head/grep just to shorten results or mask failures with || echo. Search returned saved paths with rg, then read_file at relevant lines; rerun only after a relevant change or for a new check. Avoid byte truncation of non-ASCII text.
- Access uses the runtime's current sandbox and approval policy. Network authorization follows actual domains/ports; dependency downloads do not inherently require leaving the sandbox. For a necessary command blocked by sandbox permissions, request require_escalated for that operation rather than changing implementation to evade the restriction. A denial or unavailable approval channel is not permission to bypass it.
- Local search uses rg --files (paths), ls (directory entries), rg -n (content) and rg -F (literal text). Quote globs and paths; use -e for the pattern. Recognized read commands run with no writes or network, trusted host programs, no rg config/global-ignore files, and exact authorized read scopes. Read-only roles support literal rg/ls/pwd/cat/head/tail/wc/echo commands and safe combinations, not shell expansion, redirection, preprocessing or arbitrary programs. Search saved output using its exact provided path; private storage directory scans are forbidden. Use read_file before editing: Bash output does not establish a file read version. Missing rg is a host setup issue, not a reason to install during the task.
- Run a minimal existing syntax/build/test check before starting a server. Use run_in_background for services, GUIs and watchers, omit timeout_ms, and manage the returned task ID with task. Do not use shell &. A foreground timeout terminates the process and its children. Reuse an existing managed service; stop it before restarting and do not overlap instances or take over unrelated processes with lsof/kill.
- For a port conflict, use supported temporary CLI/env options without changing project defaults or stopping unrelated processes. A genuine permission denial must not be bypassed by switching ports.
- Local HTTP probes verify endpoints only: use bounded readiness retries and fail on HTTP errors (for example --fail-with-body); inspect required status/fields. Do not use fixed sleeps or treat HTTP 200 as browser verification. Do not create missing browser capability; existing E2E runs unchanged, and new automation infrastructure requires an explicit user request.
- Git: inspect status/diff/log. Commit and push each require authorization; check staged, unstaged and untracked changes before committing. Stage exact paths with git add -- <paths>. Do not use git add . or git add -A, skip hooks, change Git config, auto-stash/reset/clean or amend without authorization. Check branch, remote and outgoing commits before pushing; verify actual results.`,
    parameters: inputSchema,
    maxResultSizeChars: 30_000,
    isReadOnly: ({command, sandbox_permissions}) =>
        sandbox_permissions !== "require_escalated" &&
        (!!analyzeReadCommand(command) || isShellCommandReadOnly(command)),
    isConcurrencySafe: ({command, sandbox_permissions}) =>
        sandbox_permissions !== "require_escalated" &&
        (!!analyzeReadCommand(command) || isShellCommandReadOnly(command)),
    requiresExplicitApproval: ({sandbox_permissions}) => sandbox_permissions === "require_escalated",
    getDefaultApprovalScope: ({sandbox_permissions}, ctx) =>
        sandbox_permissions !== "require_escalated" &&
            ctx.shellRunner.sandboxStatus.kind === "ready"
            ? {kind: "sandboxed"}
            : undefined,
    async checkPermissions({command, cwd, sandbox_permissions}, ctx) {
        if (hasShellBackgroundOperator(command)) {
            return {behavior: "deny", message: backgroundSyntaxMessage()};
        }
        const commandCwd = await resolveCommandCwd(ctx.cwd, cwd, ctx.permissionMode === "full-access" && ctx.allowFullAccess);
        if (!commandCwd.ok) {
            return {behavior: "deny", message: commandCwd.message};
        }
        if ((ctx.readOnlyTools || ctx.collaborationMode === "plan") && sandbox_permissions === "require_escalated") {
            return {behavior: "deny", message: "Read-only command execution cannot leave the Sandbox"};
        }
        if (sandbox_permissions !== "require_escalated") {
            try {await prepareCommandReadAccess(command, commandCwd.path, ctx);}
            catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
        }
        if (sandbox_permissions === "require_escalated") {
            return {
                behavior: "ask",
                message: [
                    "This command requests execution outside the OS Sandbox on the host:",
                    `  ${command}`,
                    "Outside the Sandbox, the command and its children are no longer protected by file and network boundaries. Continue?",
                ].join("\n"),
            };
        }
        if (analyzeReadCommand(command) || isShellCommandReadOnly(command)) {
            return {behavior: "allow"};
        }

        return {
            behavior: "ask",
            message: `Command to execute:\n  ${command}\nRun this command?`,
        };
    },
    // Split shell subcommands and match them according to rule behavior.
    // deny/ask: any matching subcommand is sufficient.
    // allow: a simple rule must match all subcommands; compound rules match each segment in order.
    // Prevent bash(npm:*) from authorizing all of "npm test && rm -rf x".
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
                        yield_time_ms,
                        sandbox_permissions,
                    }, ctx, invocation) => {
        if (run_in_background && yield_time_ms !== undefined) return {content: "yield_time_ms and run_in_background=true cannot be combined", outcome: "failed" as const};
        if (hasShellBackgroundOperator(command)) {
            return {
                content: backgroundSyntaxMessage(),
                outcome: "failed" as const,
            };
        }
        const resolvedCwd = await resolveCommandCwd(ctx.cwd, cwd, ctx.permissionMode === "full-access" && ctx.allowFullAccess);
        if (!resolvedCwd.ok) {
            return {content: resolvedCwd.message, outcome: "failed" as const};
        }
        const commandCwd = resolvedCwd.path;
        const readAccess = sandbox_permissions !== "require_escalated"
            ? await prepareCommandReadAccess(command, commandCwd, ctx) : undefined;
        if (readAccess && (run_in_background || yield_time_ms !== undefined)) {
            return {content: "Read-only searches run in the foreground with a timeout; do not start them as background tasks.", outcome: "failed" as const};
        }
        const effectiveSandboxPermissions = readAccess ? "use_default" as const : ctx.permissionMode === "full-access" && ctx.allowFullAccess
            ? "require_escalated" as const : sandbox_permissions;
        const networkEvidence = structuredClone(ctx.approvalEvidence?.() ?? []);
        const detached = run_in_background === true || yield_time_ms !== undefined;
        const networkEpoch = new ApprovalEpoch();
        const networkBudget = new ApprovalBudget();
        const networkAccess = ctx.networkAccess ? {
            session: ctx.networkAccess,
            canUseTool: async (_tool: string, message: string, input: unknown, options?: Parameters<ToolContext["canUseTool"]>[3]) => {
                const requestSignal = options?.signal ?? ctx.signal;
                const networkContext: ToolContext = {...ctx, signal: requestSignal, approvalEpoch: networkEpoch,
                    approvalBudget: networkBudget, approvalEvidence: () => networkEvidence,
                    onApprovalEvent: detached ? undefined : ctx.onApprovalEvent,
                    permissionPromptPolicy: detached || ctx.signal.aborted ? "never" : ctx.permissionPromptPolicy};
                const resolution = await requestApproval(networkContext, "bash", {command, cwd: commandCwd,
                    connection: input}, message, invocation.toolCallId, {...options, signal: requestSignal});
                return resolution.decision;
            },
            canReview: () => ctx.permissionMode === "auto-review" || (!detached && !ctx.signal.aborted && ctx.permissionPromptPolicy === "onRequest"),
        } : undefined;
        if (run_in_background || yield_time_ms !== undefined) {
            if (
                effectiveSandboxPermissions !== "require_escalated" &&
                ctx.shellRunner.sandboxStatus.kind === "unavailable"
            ) {
                return {
                    content: `Sandbox unavailable; background command was not started: ${ctx.shellRunner.sandboxStatus.reason}`,
                    outcome: "failed" as const,
                };
            }
            if (!ctx.tasks) {
                return {
                    content: "This Runtime does not support background Bash tasks",
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
                            `The same background command is already running in this directory. Task: ${duplicate.id}\n` +
                            "Inspect with task status first; if a restart is needed, use task stop. Do not start duplicates or kill processes by port.",
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
                    ...(yield_time_ms !== undefined ? {waitMs: yield_time_ms, timeoutMs: timeout_ms, signal: ctx.signal} : {}),
                });
                if (task.status !== "running") {
                    return {
                        content: formatObservedBackgroundTask(task, yield_time_ms !== undefined),
                        outcome: task.status === "completed"
                            ? "ok" as const
                            : task.status === "cancelled"
                                ? "interrupted" as const
                                : "failed" as const,
                    };
                }
                return {
                    content: [
                        yield_time_ms !== undefined ? "Command is still running and moved to the background (same process)." : "Background task started.",
                        `Task: ${task.id}`,
                        "Lifecycle: managed by the current HiCode Runtime; terminates when HiCode exits.",
                        `Status: ${task.status}`,
                        `Cwd: ${displayToolPath(ctx.cwd, commandCwd) || "."}`,
                        ...(timeout_ms !== undefined && yield_time_ms === undefined
                            ? ["Ignored timeout_ms: background tasks do not use the foreground execution timeout."]
                            : []),
                        runningOutput(task),
                        "Use task to inspect output, completion status or stop the task.",
                    ].join("\n"),
                    outcome: "ok" as const,
                };
            } catch (error) {
                return {
                    content: `Failed to start background task: ${error instanceof Error ? error.message : String(error)}`,
                    outcome: "failed" as const,
                };
            }
        }
        const execute = async () => {
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
                    ...(readAccess ? {readAccess} : {}),
                });
                const noMatches = readAccess?.plan.singleSearch === true && result.termination.kind === "exit" &&
                    result.termination.code === 1 && result.termination.signal === null && !result.stdout.trim() &&
                    !result.stderr.trim() && result.outputComplete !== false;
                const shouldPersist =
                    (result.outputBytes ?? 0) > 30_000 ||
                    result.outputComplete === false;
                if (!shouldPersist || result.termination.kind === "aborted") {
                    return {
                        content: formatShellResult(result, noMatches),
                        outcome: noMatches ? "ok" as const : shellOutcome(result),
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
                        content: `${formatShellResult(result)}\n\nFailed to save full output: ${error instanceof Error ? error.message : String(error)}`,
                        outcome: shellOutcome(result),
                    };
                }
            } finally {
                await ctx.toolResultStore.removeTemporaryFile(capturePath);
            }
        };
        return readAccess ? execute() : ctx.fileCommits.exclusive(ctx.signal, execute);
    },
};

/** Maintenance and review can search through Bash without gaining its general execution capability. */
export function createReadOnlyBashTool(): Tool<typeof inputSchema> {
    return {...bashTool,
        async checkPermissions(input, ctx) {
            if (input.run_in_background || input.yield_time_ms !== undefined) return {behavior: "deny", message: "Restricted searches must finish in the current invocation"};
            return bashTool.checkPermissions!(input, {...ctx, readOnlyTools: true});
        },
        execute(input, ctx, invocation) {
            return bashTool.execute(input, {...ctx, readOnlyTools: true}, invocation);
        },
    };
}
