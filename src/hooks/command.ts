import {runShellArgv, runShellCommand} from "../tools/bash/process.js";
import {hookOutputSchema} from "./schema.js";
import {boundedHookMessage, type HookHandlerResult} from "./handler.js";
import {hookHandler} from "./identity.js";
import type {HookCommand, HookEnvelope, HookSettings} from "./types.js";

interface HookCommandRunResult {
    stdout: string; stderr: string;
    termination: {kind: "exit"; code: number} | {kind: "aborted"} | {kind: "timeout"; timeoutMs: number}
        | {kind: "output_limit"; maxBuffer: number} | {kind: "spawn_error"; message: string};
}
type ExecuteHookCommandInput = HookCommand & {
    cwd: string; stdin: string; signal: AbortSignal; timeoutMs: number; environment: NodeJS.ProcessEnv;
};
export type ExecuteHookCommand = (input: ExecuteHookCommandInput) => Promise<HookCommandRunResult>;
export async function defaultExecuteHookCommand(input: ExecuteHookCommandInput): Promise<HookCommandRunResult> {
    const options = {cwd: input.cwd, signal: input.signal, timeoutMs: input.timeoutMs,
        maxBuffer: 64 * 1024, stdin: input.stdin, env: input.environment};
    const result = input.executable !== undefined
        ? await runShellArgv({...options, argv: [input.executable, ...input.args]})
        : input.shell === "powershell"
            ? await runShellArgv({...options, argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", input.command]})
            : await runShellCommand({...options, command: input.command});
    const termination = result.termination;
    return {stdout: result.stdout, stderr: result.stderr,
        termination: termination.kind === "spawn_error"
            ? {kind: "spawn_error", message: termination.error.message} : termination};
}
export async function executeCommandHook(options: {
    hook: Extract<HookSettings, {type: "command"}>;
    envelope: HookEnvelope;
    signal: AbortSignal;
    timeoutMs: number;
    executeCommand: ExecuteHookCommand;
    environment: NodeJS.ProcessEnv;
}): Promise<HookHandlerResult> {
    const {hook, envelope, signal} = options;
    const started = performance.now();
    const identity = {event: envelope.event.hook_event_name, source: envelope.source.source,
        type: "command" as const, handler: hookHandler(hook), commandInvoked: true as const};
    let run: HookCommandRunResult;
    try {
        run = await options.executeCommand({...hook, cwd: envelope.cwd,
            stdin: `${JSON.stringify(envelope)}\n`, signal, timeoutMs: options.timeoutMs, environment: options.environment});
    } catch (error) {
        return {execution: {...identity, outcome: "error", durationMs: performance.now() - started,
            message: boundedHookMessage(`Hook 启动失败: ${error instanceof Error ? error.message : String(error)}`)}};
    }
    const base = {...identity, durationMs: performance.now() - started};
    const diagnostic = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    const fail = (message: string): HookHandlerResult => ({diagnostic,
        execution: {...base, outcome: "error", message: boundedHookMessage(message)}});
    if (run.termination.kind === "aborted") return {diagnostic, interrupted: true,
        execution: {...base, outcome: "interrupted", message: "Hook 执行已取消"}};
    if (run.termination.kind === "timeout") return fail(`Hook 超时 (${run.termination.timeoutMs}ms)`);
    if (run.termination.kind === "output_limit" || Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr) > 64 * 1024)
        return fail("Hook 输出超过 65536 bytes 上限");
    if (run.termination.kind === "spawn_error") return fail(`Hook 启动失败: ${run.termination.message}`);
    const exitCode = run.termination.code;
    let raw: unknown;
    if (exitCode === 2 && hook.purpose === "control") {
        raw = {decision: envelope.event.hook_event_name === "Stop" ? "continue" : "block",
            reason: boundedHookMessage((run.stderr || run.stdout).trim() || "Hook 阻止了操作")};
    } else if (exitCode !== 0) return fail(run.stderr.trim() || `Hook 退出码 ${exitCode}`);
    else {
        try {raw = run.stdout.trim() ? JSON.parse(run.stdout) : hook.purpose === "observe" ? {}
            : {decision: envelope.event.hook_event_name === "Stop" ? "accept" : "pass"};}
        catch {return fail("Hook stdout 不是合法 JSON");}
    }
    const parsed = hookOutputSchema(envelope.event.hook_event_name, hook.purpose).safeParse(raw);
    if (!parsed.success) return fail(`Hook ${envelope.event.hook_event_name}/${hook.purpose} 输出校验失败: ${parsed.error.message}`);
    return {diagnostic, output: parsed.data, execution: {...base, exitCode,
        outcome: parsed.data.decision === "block" || parsed.data.decision === "continue" ? "blocking" : "success",
        ...(parsed.data.reason ? {message: parsed.data.reason} : {}),
        ...(parsed.data.userMessage ? {userMessage: parsed.data.userMessage} : {})}};
}
