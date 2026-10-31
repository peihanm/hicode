import {approveWriteDirectories, validateWriteDirectories} from "./writeAccess.js";
import {shellResultUI} from "./receipt.js";
import {captureApprovalEvidence} from "../../permissions/reviewer/evidence.js";
import {noMatchSearch, shellOutcome} from "./result.js";
import {formatTaskHeader} from "../../tasks/format.js";
import {z} from "zod";
import {ApprovalBudget, requestApproval} from "../../permissions/approval.js";
import {realpath, stat} from "node:fs/promises";
import {resolve} from "node:path";
import {ToolInputError, type Tool, type ToolContext} from "../types.js";
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
import {checkMemoryStoragePath} from "../../memory/publicationAccess.js";
import {analyzeReadCommand} from "../../permissions/shellRead.js";
import {isPathInside} from "../../permissions/pathGuard.js";
import {taskNotificationId} from "../../tasks/notifications.js";

const inputSchema = z.object({
    command: z.string().describe(
        "Shell command. pipefail is enabled (not set -e); failed pipeline stages retain a nonzero status. A trailing echo/printf still overwrites the command-list status. Run checks directly or chain with &&; if printing a status, capture it immediately and exit with it. Handle expected failures explicitly. Do not pipe tests to head, assume SIGPIPE is success, byte-truncate non-ASCII output, or append &."
    ),
    cwd: z
        .string()
        .min(1)
        .optional()
        .describe("Existing working directory, relative to the current project or an absolute path permitted by runtime policy. To create a directory, run mkdir from an existing parent first. Each call is independent; previous cd state is not retained."),
    additional_write_directories: z.array(z.string().min(1)).max(8).optional().describe("Existing extra directories this command needs to write, relative to the Agent cwd or absolute. Request before running builds/installers outside authorized write roots. Approval applies to this process tree, or the Session if explicitly selected. A cwd alone grants no write access. Failed commands are not automatically retried."),
    run_in_background: z
        .boolean()
        .optional()
        .describe("For services/watchers or finite work the user permits to finish after this reply. Returns a Task ID after a brief startup check; report started, not completed. Do not use when the current request requires the result. Survives a normal reply; runs until exit, explicit stop or owner shutdown. In Ask mode background tasks can use existing Session network grants but cannot request new ones; run installs in the foreground when approval may be needed."),
    yield_time_ms: z.number().int().min(100).max(30_000).optional()
        .describe("Wait 100-30000ms (default 10000 in continuable execution); return final output or the same running process as a Task ID. This is only a waiting window, never a process deadline. In restricted Ask, explicit yield has no human network approval channel; omit it to keep foreground interaction. One-shot hosts and protected file searches do not accept yield. Do not combine with run_in_background=true."),
    sandbox_permissions: z
        .enum(["use_default", "require_escalated"])
        .optional()
        .describe("use_default follows the runtime sandbox policy; network access is authorized by domain/port without inherently leaving the sandbox. Use require_escalated only when leaving the sandbox is necessary; it has a separate authorization boundary."),
}).strict();

type CommandCwdResult =
    | {ok: true; path: string}
    | {ok: false; outcome: "failed" | "denied"; message: string};

async function resolveCommandCwd(
    projectCwd: string,
    requestedCwd: string | undefined,
    boundary: string
): Promise<CommandCwdResult> {
    const candidate = resolve(projectCwd, requestedCwd ?? ".");
    try {
        const [projectRealPath, candidateRealPath, candidateStat] =
            await Promise.all([
                realpath(boundary),
                realpath(candidate),
                stat(candidate),
            ]);
        if (!isPathInside(projectRealPath, candidateRealPath)) {
            return {
                ok: false,
                outcome: "denied",
                message: `Bash cwd is outside the Host boundary: ${requestedCwd}`,
            };
        }
        if (!candidateStat.isDirectory()) {
            return {ok: false, outcome: "failed", message: `Bash cwd is not a directory: ${candidate}`};
        }
        return {ok: true, path: candidateRealPath};
    } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ENOENT") return {
            ok: false, outcome: "failed",
            message: `Bash working directory does not exist: ${candidate}. Run mkdir from an existing parent directory first. The command was not executed.`,
        };
        if (code === "ENOTDIR") return {
            ok: false, outcome: "failed", message: `Bash cwd is not a directory: ${candidate}. The command was not executed.`,
        };
        return {
            ok: false,
            outcome: code === "EACCES" || code === "EPERM" ? "denied" : "failed",
            message: `Cannot use Bash cwd ${requestedCwd ?? "."}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

async function commandWorkspace(ctx: ToolContext, cwd: string | undefined): Promise<{root: string; writable: boolean} | undefined> {
    const target = resolve(ctx.cwd, cwd ?? ".");
    const root = ctx.shellWorkspace ?? await ctx.memoryFiles?.shellDirectory(target);
    if (!root) {
        if (await checkMemoryStoragePath(ctx.storage, target)) throw new Error("This Agent has no Memory file workspace capability for this directory");
        return undefined;
    }
    // A Bash directory capability never overrides explicit file-tool denial/approval rules.
    if ([...ctx.permissionRules.deny, ...ctx.permissionRules.ask].some(rule => ["read_file", "write_file", "edit_file"].includes(rule.toolName)))
        throw new Error("Memory Bash cannot bypass explicit file access rules; use the file tools or revise the applicable rules");
    return {root, writable: !ctx.readOnlyTools};
}

function backgroundSyntaxMessage(): string {
    return "Unsupported Bash command: shell background operator & is not supported. The command was not executed; additional permission will not enable this syntax. For a persistent service, omit & and use run_in_background=true; manage its Task ID with task status/stop. For a finite subprocess or signal test, run a foreground test program that creates, signals, waits for and cleans up its own children, including on failure. Sandbox and permission rules still apply.";
}

function commandSyntaxIssue(command: string): string | undefined {
    try {
        return hasShellBackgroundOperator(command) ? backgroundSyntaxMessage() : undefined;
    } catch (error) {
        if (error instanceof SyntaxError) return `Unsupported Bash command: ${error.message}. The command was not executed.`;
        throw error;
    }
}

function runningOutput(task: ShellTaskSnapshot, service: boolean): string {
    if (!task.output) return task.outputIssue
        ? `Output unavailable: ${task.outputIssue}`
        : service ? "No output captured yet. Use task status to check readiness and the actual address before probing a service; do not assume its default port." : "No output captured yet. Use task wait when this command blocks further work; no output alone does not mean it has stalled.";
    const bytes = Buffer.from(task.output, "utf8");
    const limit = 4000;
    const start = Math.max(0, bytes.length - limit);
    const preview = selectUtf8Range(bytes.subarray(start), limit).content.toString("utf8");
    return `Captured output (not a readiness check):\n${start ? "[Earlier output omitted; use task status for more]\n" : ""}${preview}`;
}

function formatShellResult(result: ShellExecutionResult, noMatches?: "rg" | "grep"): string {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const termination = result.termination;
    if (noMatches) return `No matches found (${noMatches} exit code 1).`;
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
        ? "\nThe command and its child processes have terminated under a host execution deadline; they will not continue in the background. Check partial effects and available checkpoints before retrying. yield_time_ms only controls when control returns, not process lifetime."
        : "";
    const heading = termination.kind === "exit" && !termination.signal
        ? `Command exited with code ${termination.code}`
        : `Execution failed (${status})`;
    return `${heading}:\n${detail || "(no output)"}${timeoutNotice}`;
}

function formatShellStatus(result: ShellExecutionResult): string {
    const termination = result.termination;
    if (termination.kind === "exit" && termination.code === 0) {
        return "Command succeeded (exit code 0).";
    }
    if (termination.kind === "exit") {
        return termination.signal ? `Command terminated by signal ${termination.signal}.`
            : `Command exited with code ${termination.code}.`;
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
            : task.termination?.kind === "exit" && !task.outputIssue
                ? "Background command exited during the startup observation window."
            : "Background task failed during the startup observation window.";
    return [
        formatTaskHeader(task),
        yielded ? `Command ended: ${task.status}.` : heading,
        `Termination: ${shellTaskTermination(task)}`,
        task.output || "(no output)",
        ...(task.outputIssue ? [`Output delivery issue: ${task.outputIssue}`] : []),
        ...(task.outputResult
            ? [`Saved output: ${JSON.stringify(task.outputResult.path)}`]
            : []),
    ].join("\n");
}

export const bashTool: Tool<typeof inputSchema> = {
    name: "bash",
    description: `Run shell commands, project scripts, dependencies, builds and tests; return stdout/stderr. Use read_file/write_file/edit_file for file contents, Bash rg for search, and rm for authorized file deletion.
- Use $TMPDIR for temporary files and clean up only artifacts you created; directory grants and explicit denials still apply.
- Each call is a separate process: pass cwd rather than relying on a previous cd. Run tests/builds directly; the runtime preserves and budgets output. Do not add tail/head/grep just to shorten results or mask failures with || echo. Search returned saved paths with rg, then read_file at relevant lines; rerun only after a relevant change or for a new check. Avoid byte truncation of non-ASCII text.
- When independent operations need separate success/failure judgments, issue separate Bash calls in the same tool batch. A command list joined with semicolons exposes only its final status; it does not report each operation's exit code.
- A running Task ID returns control, not a stable workspace. If a background command changes Git state (such as stash/restore or branch switching), installs dependencies or rewrites build outputs, wait for that exact task to finish and inspect its result and resulting workspace state before running edits, builds or tests that depend on those changes. Continue only independent work while it runs; completion alone does not prove restoration succeeded.
- Access uses the runtime's current sandbox and approval policy. Network authorization follows actual domains/ports; dependency downloads do not inherently require leaving the sandbox. For a necessary command blocked by sandbox permissions, request require_escalated for that operation rather than changing implementation to evade the restriction. A denial or unavailable approval channel is not permission to bypass it.
- Local search uses rg --files (paths), ls (directory entries), rg -n (content) and rg -F (literal text). Quote globs and paths; use -e for the pattern. Recognized read commands run with no writes or network, trusted host programs, no rg config/global-ignore files, and exact authorized read scopes. Read-only roles support literal rg/ls/pwd/cat/head/tail/wc/echo commands and safe combinations, not shell expansion, redirection, preprocessing or arbitrary programs. Search saved output using its exact provided path; private storage directory scans are forbidden. Use read_file before editing: Bash output does not establish a file read version. Missing rg is a host setup issue, not a reason to install during the task.
- Run a minimal existing syntax/build/test check before starting a server. Use run_in_background for services/watchers or finite work the user permits to finish after your reply; manage the returned Task ID with task. Report startup separately from completion. When the requested result depends on a test/build, use ordinary Bash and collect its result before claiming completion. Ordinary continuable commands wait 10 seconds by default, then return the same running process as a Task; yield_time_ms changes only that window. Use task wait with its ID when its result blocks work, not sleep/pgrep loops. Bash has no model-set execution deadline. Waiting does not stop the process; explicit task stop, owner shutdown and host execution budgets still apply. A normal final reply does not close background tasks. Restricted Ask commands stay foreground for network interaction unless explicitly yielded; one-shot Hosts and protected file commands stay foreground. Do not use shell &. For finite subprocess/signal tests, use one foreground test program to create, signal, wait for and clean up its own children in a finally block; keep normal Sandbox and permission checks. Reuse an existing managed service; stop it before restarting and do not overlap instances or take over unrelated processes with lsof/kill.
- For tests, training, builds and installs of uncertain duration, inspect progress and wait on the same Task ID. Do not invent a short kill deadline with shell timeout or restart a task that is still running. Stop explicitly when the user requests it or evidence shows the work is unnecessary or stuck; elapsed time or silence alone is not proof. Use a shell deadline only when forced termination is part of the requested operation.
- For a port conflict, use supported temporary CLI/env options without changing project defaults or stopping unrelated processes. A genuine permission denial must not be bypassed by switching ports.
- Local HTTP probes verify endpoints only: use bounded readiness retries and fail on HTTP errors (for example --fail-with-body); inspect required status/fields. Do not use fixed sleeps or treat HTTP 200 as browser verification. Do not create missing browser capability; existing E2E runs unchanged, and new automation infrastructure requires an explicit user request.
- For failed network queries/downloads, inspect the actual error, including saved output, before diagnosing DNS, connection, TLS, HTTP errors or transfer timeout. Received HTTP headers or partial body followed by timeout means this transfer is incomplete, not that networking is unavailable. If an extra connectivity probe is needed, prefer the target resource's headers or small metadata with bounded connection and total timeouts; do not download entire registry indexes or large files just to test connectivity. HEAD rejection alone does not establish unavailability. Set download limits for the actual resource and task; retry only with new evidence or a corrected request, not repeated identical failures.
- Git: inspect status/diff/log. User-authorized local staging and commits use the sandbox without a separate access-approval question. Push requires user authorization; reuse explicit authorization already given for that push rather than asking again. Force-push, remote branch deletion, reset --hard, clean and discarding local work require authorization covering those effects; check staged, unstaged and untracked changes before committing. Stage exact paths with git add -- <paths>. Do not use git add . or git add -A, skip hooks, change Git config, auto-stash/reset/clean or amend without authorization. Check branch, remote and outgoing commits before pushing; verify actual results.`,
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
    async checkPermissions({command, cwd, sandbox_permissions, run_in_background, yield_time_ms, additional_write_directories}, ctx) {
        const syntaxIssue = commandSyntaxIssue(command);
        if (syntaxIssue) throw new ToolInputError(syntaxIssue);
        try {await validateWriteDirectories(additional_write_directories ?? [], ctx);}
        catch (error) {return {behavior: "deny", message: String(error)};}
        let workspace;
        try {workspace = await commandWorkspace(ctx, cwd);} catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOTDIR") {
                throw new ToolInputError(`Bash cwd is not a directory: ${resolve(ctx.cwd, cwd ?? ".")}. The command was not executed.`);
            }
            return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};
        }
        if (workspace && !workspace.writable && !analyzeReadCommand(command)) return {behavior: "deny", message: "Read-only Memory commands cannot modify files or execute arbitrary programs"};
        if (workspace && (sandbox_permissions === "require_escalated" || run_in_background || yield_time_ms !== undefined)) return {behavior: "deny", message: "Memory file commands must run in the foreground inside their Sandbox"};
        const commandCwd = await resolveCommandCwd(workspace?.root ?? ctx.cwd, cwd, workspace?.root ?? ctx.workspaceBoundary ?? ctx.directoryAccess.hardBoundary);
        if (!commandCwd.ok) {
            if (commandCwd.outcome === "failed") throw new ToolInputError(commandCwd.message);
            return {behavior: "deny", message: commandCwd.message};
        }
        if ((ctx.readOnlyTools || ctx.permissionActor) && sandbox_permissions === "require_escalated") {
            return {behavior: "deny", message: "Child Agent or read-only command execution cannot leave the Sandbox"};
        }
        if (sandbox_permissions !== "require_escalated") {
            try {await prepareCommandReadAccess(command, workspace ? resolve(workspace.root, cwd ?? ".") : commandCwd.path, ctx);}
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
                        run_in_background,
                        yield_time_ms,
                        sandbox_permissions,
                        additional_write_directories,
                    }, ctx, invocation) => {
        if (run_in_background && yield_time_ms !== undefined) return {content: "yield_time_ms and run_in_background=true cannot be combined", outcome: "failed" as const};
        const syntaxIssue = commandSyntaxIssue(command);
        if (syntaxIssue) return {content: syntaxIssue, outcome: "failed" as const};
        const workspace = await commandWorkspace(ctx, cwd);
        if (workspace && !workspace.writable && !analyzeReadCommand(command)) return {content: "Read-only Memory commands cannot modify files or execute arbitrary programs", outcome: "failed" as const};
        if (workspace && (sandbox_permissions === "require_escalated" || run_in_background || yield_time_ms !== undefined)) return {content: "Memory file commands must run in the foreground inside their Sandbox", outcome: "failed" as const};
        const resolvedCwd = await resolveCommandCwd(workspace?.root ?? ctx.cwd, cwd, workspace?.root ?? ctx.workspaceBoundary ?? ctx.directoryAccess.hardBoundary);
        if (!resolvedCwd.ok) {
            return {content: resolvedCwd.message, outcome: resolvedCwd.outcome};
        }
        let additionalWrites: string[];
        try {
            additionalWrites = await approveWriteDirectories(additional_write_directories ?? [],
                {command, cwd, run_in_background, yield_time_ms, sandbox_permissions, additional_write_directories}, ctx, invocation.toolCallId);
        } catch (error) {return {content: `Directory approval failed: ${String(error)}`, outcome: ctx.signal.aborted ? "interrupted" as const : "denied" as const};}
        const commandCwd = workspace ? resolve(workspace.root, cwd ?? ".") : resolvedCwd.path;
        const readAccess = sandbox_permissions !== "require_escalated"
            ? await prepareCommandReadAccess(command, commandCwd, ctx) : undefined;
        if (readAccess && (run_in_background || yield_time_ms !== undefined)) {
            return {content: "Read-only searches must finish in the foreground; do not yield or start them as background tasks.", outcome: "failed" as const};
        }
        const effectiveSandboxPermissions = readAccess || workspace ? "use_default" as const : ctx.permissionMode === "full-access" && ctx.allowFullAccess && !ctx.permissionActor
            ? "require_escalated" as const : sandbox_permissions;
        const needsNetworkApproval = !!ctx.networkAccess && effectiveSandboxPermissions !== "require_escalated" &&
            ctx.shellRunner.sandboxStatus.kind === "ready" && ctx.shellRunner.sandboxStatus.networkMode === "restricted";
        const networkEvidence = needsNetworkApproval ? ctx.approvalEvidence?.() ?? captureApprovalEvidence([]) : undefined;
        const restrictedHuman = ctx.permissionMode === "ask" && effectiveSandboxPermissions !== "require_escalated" &&
            ctx.shellRunner.sandboxStatus.kind === "ready" && ctx.shellRunner.sandboxStatus.networkMode === "restricted";
        const canContinue = !!ctx.tasks?.shellContinuation && !workspace && !readAccess && (!restrictedHuman || yield_time_ms !== undefined);
        if (yield_time_ms !== undefined && !canContinue) return {content:
            "This command requires foreground execution (one-shot Host or protected file access). Omit yield_time_ms; it will wait for completion or cancellation without an implicit 30-second limit.", outcome: "failed" as const};
        const managed = run_in_background === true || canContinue;
        let interaction: Pick<ToolContext, "canUseTool" | "onApprovalEvent"> | undefined = run_in_background || (restrictedHuman && yield_time_ms !== undefined)
            ? undefined : {canUseTool: ctx.canUseTool, onApprovalEvent: ctx.onApprovalEvent};
        const networkBudget = new ApprovalBudget();
        const networkBase: ToolContext = {...ctx, canUseTool: async () => ({behavior: "deny", message: "Task has no human interaction channel"}),
            onApprovalEvent: undefined, signal: AbortSignal.abort("task-request-signal-required"), approvalBudget: networkBudget};
        const networkAccess = needsNetworkApproval && ctx.networkAccess ? {
            session: ctx.networkAccess,
            canUseTool: async (_tool: string, message: string, input: unknown, options?: Parameters<ToolContext["canUseTool"]>[3]) => {
                const requestSignal = options?.signal ?? networkBase.signal;
                const networkContext: ToolContext = {...networkBase, signal: requestSignal,
                    canUseTool: (tool, message, input, options) => interaction?.canUseTool(tool, message, input, options) ??
                        Promise.resolve({behavior: "deny", message: "Task has no human interaction channel"}),
                    approvalEvidence: networkEvidence ? () => networkEvidence : undefined,
                    onApprovalEvent: event => interaction?.onApprovalEvent?.(event),
                    permissionPromptPolicy: interaction && !ctx.signal.aborted ? ctx.permissionPromptPolicy : "never"};
                const resolution = await requestApproval(networkContext, "bash", {command, cwd: commandCwd,
                    connection: input}, message, invocation.toolCallId, {...options, signal: requestSignal});
                return resolution.decision;
            },
            canReview: () => networkBase.permissionMode === "auto-review" || (!!interaction && !ctx.signal.aborted && ctx.permissionPromptPolicy === "onRequest"),
        } : undefined;
        if (managed) {
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
                            `The same background command is already running in this directory. task_id: ${duplicate.id}\n` +
                            "Inspect with task status first; if a restart is needed, use task stop. Do not start duplicates or kill processes by port.",
                        outcome: "failed" as const,
                    };
                }
                const taskInput = {
                    command,
                    cwd: commandCwd,
                    toolCallId: invocation.toolCallId,
                    maxOutputBytes: ctx.toolResultStore.maxArtifactBytes,
                    sandboxPermissions: effectiveSandboxPermissions,
                    writableRoots: [...ctx.directoryAccess.listDirectories(), ...additionalWrites],
                    deniedReadRoots: ctx.permissionActor ? [ctx.storage.projectsRoot] : undefined,
                    networkAccess,
                };
                const started = run_in_background ? {kind: "task" as const, task: await ctx.tasks.startShell(taskInput)}
                    : await ctx.tasks.runShell({...taskInput, waitMs: yield_time_ms ?? 10_000,
                        signal: ctx.signal, onHandoff: () => {interaction = undefined;}});
                if (started.kind === "inline") {
                    const status = started.outputIssue ? `\nOutput delivery failed: ${started.outputIssue}` : "";
                    return {...shellResultUI(started.result.termination, !!started.outputIssue), content: (started.persisted ? formatShellStatus(started.result) : formatShellResult(started.result, noMatchSearch(command, started.result))) + status,
                        ...(started.persisted ? {persisted: started.persisted, displayContent: formatShellStatus(started.result) + "\n" + started.persisted.preview + status} : {}),
                        outcome: started.outputIssue && shellOutcome(command, started.result) === "ok" ? "output_failed" as const : shellOutcome(command, started.result)};
                }
                const task = started.task;
                if (task.status !== "running") {
                    return {
                        ...shellResultUI(task.termination, !!task.outputIssue),
                        content: formatObservedBackgroundTask(task, !run_in_background),
                        completedTask: {taskId: task.id, notificationId: taskNotificationId(task.id, 1)},
                        outcome: task.outputIssue
                            ? task.termination?.kind === "exit" && task.termination.code === 0 ? "output_failed" as const : "failed" as const
                            : task.status === "completed"
                            ? "ok" as const
                            : task.status === "cancelled"
                                ? "interrupted" as const
                                : "failed" as const,
                    };
                }
                return {
                    ...(!run_in_background ? {runningTask: task.id} : {}),
                    content: [
                        formatTaskHeader(task),
                        !run_in_background ? (task.phase === "running" ? "Command is still running and moved to the background (same process). This is not a successful command result." : "Command has not started; the existing task continues waiting. Do not resubmit it.") : "Background task registered.",
                        `phase: ${task.phase}`,
                        `Queued: ${task.timing.queuedMs} ms; running: ${task.timing.runningMs} ms`,
                        "Lifecycle: managed by the current HiCode Runtime; terminates when HiCode exits.",
                        `Cwd: ${displayToolPath(ctx.cwd, commandCwd) || "."}`,
                        runningOutput(task, run_in_background === true),
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
                    timeoutMs: null,
                    outputFilePath: capturePath,
                    maxOutputBytes: ctx.toolResultStore.maxArtifactBytes,
                    previewChars: 30_000,
                    sandboxPermissions: effectiveSandboxPermissions,
                    writableRoots: [...ctx.directoryAccess.listDirectories(), ...additionalWrites],
                    deniedReadRoots: ctx.permissionActor ? [ctx.storage.projectsRoot] : undefined,
                    networkAccess,
                    ...(readAccess ? {readAccess} : {}),
                    ...(workspace ? {fileWorkspace: workspace} : {}),
                });
                const noMatches = noMatchSearch(command, result);
                const shouldPersist =
                    (result.outputBytes ?? 0) > 30_000 ||
                    result.outputComplete === false;
                if (!shouldPersist || result.termination.kind === "aborted") {
                    return {
                        ...shellResultUI(result.termination),
                        content: formatShellResult(result, noMatches),
                        outcome: noMatches ? "ok" as const : shellOutcome(command, result),
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
                        ...shellResultUI(result.termination),
                        content: formatShellStatus(result),
                        displayContent: `${formatShellStatus(result)}\n${persisted.preview}`,
                        persisted,
                        outcome: shellOutcome(command, result),
                    };
                } catch (error) {
                    return {
                        ...shellResultUI(result.termination, true),
                        content: `${formatShellResult(result)}\n\nFailed to save full output: ${error instanceof Error ? error.message : String(error)}. Operation effects were not rolled back; inspect before retrying.`,
                        outcome: shellOutcome(command, result) === "ok" ? "output_failed" as const : shellOutcome(command, result),
                    };
                }
            } finally {
                await ctx.toolResultStore.removeTemporaryFile(capturePath);
            }
        };
        return execute();
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
