import {randomUUID} from "node:crypto";
import {hooksSettingsFileSchema} from "./schema.js";
import {executePromptHook, type HookPromptExecutor} from "./prompt.js";
import {defaultExecuteHookCommand, executeCommandHook, type ExecuteHookCommand} from "./command.js";
import {boundedHookMessage, type HookHandlerResult} from "./handler.js";
import {hookDefinition, hookDefinitions, hookHandler} from "./identity.js";
import {matchesHookMatcher} from "./matcher.js";
import {canonicalHookProjectPath, getHookTrust, saveHookTrust} from "./approval.js";
import {getHookTrustPath, type PillarStorageLayout} from "../persistence/layout.js";
import {mergeChildProcessEnvironment, type ChildProcessEnvironment} from "../runtime/childEnvironment.js";
import {HOOK_EVENTS, type HookBatchResult, type HookExecution,
    type HookExecutionContext, type HookInput, type HookRuntime, type HookRuntimeIssue,
     type HookTrustRequest, type HookTrustSummary, type ResolvedHookSettings,
    type HookEnvelope, type HookLifecycleEvent} from "./types.js";

interface HookRuntimeDependencies {
    executeCommand: ExecuteHookCommand;
    canonicalProjectPath(cwd: string): Promise<string>;
    getTrust?(projectPath: string, hookId: string): Promise<"allow" | "deny" | "pending">;
    saveTrust?(projectPath: string, hookId: string, decision: "always" | "deny"): Promise<void>;
}
export interface CreateHookRuntimeOptions {
    storage: PillarStorageLayout; cwd: string; hooks: ResolvedHookSettings;
    childEnvironment: ChildProcessEnvironment; headless?: boolean; signal?: AbortSignal;
    promptExecutor?: HookPromptExecutor;
    requestTrust?: (request: HookTrustRequest) => Promise<"once" | "always" | "deny">;
}
export class HookControlError extends Error {
    constructor(message: string) {super(message); this.name = "HookControlError";}
}
function queryForHook(input: HookInput): string | undefined {
    switch (input.hook_event_name) {
        case "PreToolUse": case "PostToolUse": case "PostToolUseFailure": return input.tool_name;
        case "SessionStart": return input.source;
        case "SessionEnd": return input.reason;
        case "PreCompact": case "PostCompact": return input.trigger;
        case "SubagentStart": case "SubagentStop": return input.agent_type;
        case "TurnEnd": return input.status;
        default: return undefined;
    }
}
function summarize(input: HookInput): HookInput {
    switch (input.hook_event_name) {
        case "PreToolUse": return {...input, tool_input: {}};
        case "PostToolUse": return {...input, tool_input: {},
            tool_response: {...input.tool_response, content: input.tool_response.content.slice(0, 8000)}};
        case "PostToolUseFailure": return {...input, tool_input: {},
            tool_response: {...input.tool_response, content: input.tool_response.content.slice(0, 8000)}};
        case "UserPromptSubmit": return {...input, prompt: input.prompt.slice(0, 8000)};
        case "Stop": return {...input, candidate: input.candidate.slice(0, 8000)};
        case "PreCompact": return {...input, instructions: input.instructions?.slice(0, 4000)};
        case "PostToolBatch": return {...input, tools: input.tools.slice(0, 30).map(tool => ({...tool,
            summary: tool.summary.slice(0, 200), changes: tool.changes.slice(0, 5)}))};
        default: return input;
    }
}
function validatedSettings(settings: ResolvedHookSettings): ResolvedHookSettings {
    const declared = Object.fromEntries(HOOK_EVENTS.map(event => [event, settings[event].map(({hooks, matcher, timeoutMs}) => ({hooks, matcher, timeoutMs}))]));
    hooksSettingsFileSchema.parse(declared);
    return structuredClone(settings);
}
class ConfiguredHookRuntime implements HookRuntime {
    private settings: ResolvedHookSettings;
    private approved = new Set<string>();
    private definitions: HookTrustSummary[] = [];
    private runtimeIssues: HookRuntimeIssue[] = [];
    private active = 0;
    private reloading = false;
    constructor(private readonly options: CreateHookRuntimeOptions, private readonly dependencies: HookRuntimeDependencies) {
        this.settings = options.hooks;
    }
    get enabled(): boolean {return this.approved.size > 0;}
    get issues(): readonly HookRuntimeIssue[] {return this.runtimeIssues;}
    inspect() {return this.definitions.map(item => ({...structuredClone(item), approved: this.approved.has(item.hookId)}));}
    hasToolHooks(toolName: string): boolean {
        return this.definitions.some(item => this.approved.has(item.hookId) && (
            (toolName === "agent" && (item.event === "SubagentStart" || item.event === "SubagentStop")) ||
            (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(item.event) && matchesHookMatcher(toolName, item.matcher))
        ));
    }
    async reload(settings: ResolvedHookSettings, signal: AbortSignal): Promise<void> {
        if (this.active || this.reloading) throw new Error("Hook 正在执行或重载，不能更换配置");
        this.reloading = true;
        try {
            const next = validatedSettings(settings);
            const definitions = hookDefinitions(next);
            const approved = new Set<string>();
            const pending: HookTrustSummary[] = [];
            const issues: HookRuntimeIssue[] = [];
            if (definitions.length) {
                const project = await this.dependencies.canonicalProjectPath(this.options.cwd);
                const path = getHookTrustPath(this.options.storage);
                for (const definition of definitions) {
                    if (this.approved.has(definition.hookId)) {approved.add(definition.hookId); continue;}
                    const decision = await (this.dependencies.getTrust?.(project, definition.hookId)
                        ?? getHookTrust(path, project, definition.hookId));
                    if (decision === "allow") approved.add(definition.hookId);
                    else if (decision === "pending") pending.push(definition);
                }
                if (signal.aborted) throw new Error("Hook 配置批准已取消");
                if (this.options.headless && definitions.some(item => !approved.has(item.hookId)))
                    throw new Error(`工作区 Hook 定义尚未信任，不能在 Headless 模式执行: ${project}`);
                if (pending.length && this.options.requestTrust) {
                    const decision = await this.options.requestTrust({projectPath: project, hooks: pending});
                    if (signal.aborted) throw new Error("Hook 配置批准已取消");
                    for (const item of pending) {
                        if (decision !== "deny") approved.add(item.hookId);
                        if (decision !== "once") await (this.dependencies.saveTrust?.(project, item.hookId, decision)
                            ?? saveHookTrust(path, project, item.hookId, decision));
                    }
                }
                for (const item of definitions) if (!approved.has(item.hookId)) {
                    if (item.purpose === "control") throw new HookControlError(`Control Hook 未获批准: ${item.event} ${item.hookId.slice(0, 12)}`);
                    issues.push({severity: "warning", message: `Observe Hook 未获批准，已禁用: ${item.event} ${item.hookId.slice(0, 12)}`});
                }
            }
            if (signal.aborted) throw new Error("Hook 配置重载已取消");
            this.settings = next; this.definitions = definitions; this.approved = approved; this.runtimeIssues = issues;
        } finally {this.reloading = false;}
    }
    async execute(input: HookInput, signal: AbortSignal, context?: HookExecutionContext): Promise<HookBatchResult> {
        if (this.reloading) throw new HookControlError("Hook 正在重载，拒绝开始新的执行");
        this.active++;
        try {return await this.dispatch(input, signal, context);} finally {this.active--;}
    }
    private async dispatch(input: HookInput, signal: AbortSignal, context?: HookExecutionContext): Promise<HookBatchResult> {
        const result: HookBatchResult = {blocked: false, additionalContexts: [], executions: []};
        const matchers = this.settings[input.hook_event_name].filter(matcher => matchesHookMatcher(queryForHook(input), matcher.matcher));
        if (!matchers.length) return result;
        const defaultBudget = input.hook_event_name === "TurnEnd" ? 2000 : input.hook_event_name === "SessionEnd" ? 1500 : 10000;
        const maxBudget = input.hook_event_name === "TurnEnd" ? 5000 : input.hook_event_name === "SessionEnd" ? 1500 : 30000;
        const budget = Math.min(maxBudget, Math.max(...matchers.map(item => item.timeoutMs ?? defaultBudget)));
        const deadline = performance.now() + budget;
        const dispatchId = randomUUID();
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason);
        if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, {once: true});
        const timer = setTimeout(() => controller.abort("hook-budget"), budget);
        timer.unref?.();
        const expired = () => {
            if (!controller.signal.aborted && performance.now() >= deadline) controller.abort("hook-budget");
            return controller.signal.aborted;
        };
        const emit = async (event: HookLifecycleEvent) => {
            context?.session?.record(event);
            try {await context?.onEvent?.(event);} catch { /* Host projection cannot change policy or prevent cleanup. */ }
        };
        try {
            for (const matcher of matchers) for (const hook of matcher.hooks) {
                const definition = hookDefinition(input.hook_event_name, matcher, hook);
                if (!this.approved.has(definition.hookId)) continue;
                const started = performance.now();
                const identity = {hookId: definition.hookId, dispatchId, executionId: randomUUID(),
                    startedAt: new Date().toISOString(), purpose: hook.purpose, event: input.hook_event_name,
                    source: matcher.source, type: hook.type, handler: hookHandler(hook)};
                const finish = async (handled: HookHandlerResult) => {
                    let execution: HookExecution = {...identity, ...handled.execution};
                    if (expired()) {
                        handled.output = undefined;
                        execution = {...execution, outcome: signal.aborted ? "interrupted" : execution.outcome === "skipped_budget" ? "skipped_budget" : "error",
                            message: signal.aborted ? "Hook 执行已取消" : `Hook dispatch 超时 (${budget}ms)`};
                    }
                    if (handled.diagnostic && context?.store) {
                        try {execution.artifact = await context.store.persistText({toolCallId: `hook:${identity.executionId}`,
                            toolName: `hook:${input.hook_event_name}`, content: handled.diagnostic.slice(0, 65536)});}
                        catch {execution = {...execution, outcome: "error", message: "Hook 诊断保存失败"}; handled.output = undefined;}
                    }
                    if (execution.outcome === "error" || execution.outcome === "skipped_budget") {
                        if (hook.purpose === "control") result.error ??= execution.message ?? "Control Hook 执行失败";
                    }
                    result.executions.push(execution);
                    await emit({type: "hook_completed", execution});
                    return handled.output;
                };
                const fail = async (message: string, outcome: HookExecution["outcome"] = "error") => finish({execution: {
                    ...identity, outcome, durationMs: performance.now() - started, message}});
                if (expired()) {
                    await fail(signal.aborted ? "Hook 执行已取消" : "Hook dispatch 期限已耗尽", signal.aborted ? "interrupted" : "skipped_budget");
                    continue;
                }
                const effectiveInput: HookInput = input.hook_event_name === "PreToolUse"
                    ? {...input, tool_input: result.updatedInput ?? input.tool_input} : input;
                if (hook.if) {
                    try {
                        if (!("tool_input" in effectiveInput) || !context?.matchesToolCondition)
                            throw new Error("Tool Hook 缺少 if 匹配上下文");
                        if (!await context.matchesToolCondition(hook.if, effectiveInput.tool_input)) continue;
                    } catch (error) {
                        await fail(boundedHookMessage(`Hook if 匹配失败: ${error instanceof Error ? error.message : String(error)}`));
                        if (result.error) return result;
                        continue;
                    }
                }
                if (expired()) {await fail(signal.aborted ? "Hook 已取消" : "Hook dispatch 期限已耗尽"); continue;}
                let envelope: HookEnvelope = {version: 2, cwd: this.options.cwd, hook_id: identity.hookId,
                    dispatch_id: dispatchId, execution_id: identity.executionId, purpose: hook.purpose,
                    source: matcher.source === "host" ? {source: "host", id: matcher.id} : {source: matcher.source, path: matcher.path},
                    event: effectiveInput};
                const serialized = JSON.stringify(envelope);
                const bytes = Buffer.byteLength(serialized);
                const inputLimit = hook.type === "command" && hook.purpose === "control" ? 16 * 1024 * 1024 : 65536;
                if (bytes + 1 > inputLimit) {
                    if (hook.purpose === "control") {
                        await fail(`${hook.type === "command" ? "Command" : "Prompt"} Control Hook [${hookHandler(hook).slice(0, 120)}] 完整输入 ${bytes} bytes 超过 ${inputLimit} bytes，未截断或执行判定`);
                        return result;
                    }
                    envelope = {...envelope, event: summarize(effectiveInput), truncated: true, original_bytes: bytes};
                    if (context?.store) {
                        try {const saved = await context.store.persistText({toolCallId: `hook-input:${identity.executionId}`,
                            toolName: `hook:${input.hook_event_name}`, content: serialized}); envelope.input_result_id = saved.resultId;}
                        catch {await fail("Hook 输入归档失败"); continue;}
                    }
                    if (Buffer.byteLength(JSON.stringify(envelope)) > 65536) {await fail("Hook 事件元数据仍超过输入预算"); continue;}
                }
                if (hook.once) {
                    if (!context?.session) {await fail("once Hook 缺少 Session Runtime"); if (result.error) return result; continue;}
                    if (!context.session.claimOnce(definition.hookId)) continue;
                }
                await emit({type: "hook_started", execution: identity});
                if (expired()) {await fail(signal.aborted ? "Hook 已取消" : "Hook dispatch 期限已耗尽"); continue;}
                const timeoutMs = Math.max(1, Math.min(hook.timeoutMs ?? 10000, deadline - performance.now()));
                const handled = hook.type === "command" ? await executeCommandHook({hook, envelope,
                    signal: controller.signal, timeoutMs, executeCommand: this.dependencies.executeCommand,
                    environment: mergeChildProcessEnvironment(this.options.childEnvironment, {PILLAR_PROJECT_DIR: this.options.cwd})})
                    : await executePromptHook({hook, envelope, signal: controller.signal, timeoutMs, executor: this.options.promptExecutor});
                const output = await finish(handled);
                if (result.error || signal.aborted) return result;
                if (!output) continue;
                if (output.decision === "block") {result.blocked = true; result.blockReason = output.reason;}
                if (output.decision === "continue") result.continueReason ??= output.reason;
                if (output.decision === "rewrite") result.updatedInput = output.updatedInput;
                if (output.additionalContext) {
                    const remaining = 20000 - result.additionalContexts.reduce((sum, item) => sum + item.length, 0);
                    if (remaining > 0) result.additionalContexts.push(output.additionalContext.slice(0, remaining));
                }
                if (result.blocked) return result;
            }
            return result;
        } finally {clearTimeout(timer); signal.removeEventListener("abort", onAbort);}
    }
}
export function createHookRuntimeFactory(overrides: Partial<HookRuntimeDependencies> = {}) {
    const dependencies = {executeCommand: overrides.executeCommand ?? defaultExecuteHookCommand,
        canonicalProjectPath: overrides.canonicalProjectPath ?? canonicalHookProjectPath,
        getTrust: overrides.getTrust, saveTrust: overrides.saveTrust};
    return async (options: CreateHookRuntimeOptions): Promise<HookRuntime> => {
        const runtime = new ConfiguredHookRuntime(options, dependencies);
        await runtime.reload(options.hooks, options.signal ?? new AbortController().signal);
        return runtime;
    };
}
export const createHookRuntime = createHookRuntimeFactory();
export function getHookExecutionIssues(result: HookBatchResult): string[] {
    return result.executions.filter(item => item.outcome === "error" || item.outcome === "skipped_budget")
        .map(item => `${item.event} ${item.type} Hook [${item.handler.replace(/\s+/g, " ").slice(0, 180)}] ${item.outcome}: ${boundedHookMessage(item.message ?? "")}`);
}
export function didRunCommandHook(result: HookBatchResult): boolean {
    return result.executions.some(item => item.type === "command" && item.commandInvoked === true);
}
export function formatHookContext(event: HookInput["hook_event_name"], contexts: readonly string[]): string[] {
    return contexts.map(context => `<system-reminder>\nHook ${event} provided the following additional context:\n${context}\n</system-reminder>`);
}
