import type {HookJSONOutput} from "./schema.js";
import {executePromptHook, type HookPromptExecutor,} from "./prompt.js";
import {defaultExecuteHookCommand, executeCommandHook, type ExecuteHookCommand,} from "./command.js";
import {boundedHookMessage} from "./handler.js";
import {matchesHookMatcher} from "./matcher.js";
import {canonicalHookProjectPath, getHookTrust, getHookTrustPath, saveHookTrust,} from "./approval.js";
import {mergeChildProcessEnvironment, type ChildProcessEnvironment,} from "../runtime/childEnvironment.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {
    countResolvedHooks,
    type HookBatchResult,
    type HookExecution,
    type HookExecutionContext,
    type HookInput,
    type HookRuntime,
    type HookRuntimeIssue,
    type HookSettings,
    type HookTrustRequest,
    type ResolvedHookSettings,
} from "./types.js";

const MAX_DIAGNOSTIC_COMMAND_LENGTH = 180;
const MAX_TOTAL_CONTEXT_CHARS = 20_000;

interface HookRuntimeDependencies {
    executeCommand: ExecuteHookCommand;
    canonicalProjectPath(cwd: string): Promise<string>;
    getTrust?(projectPath: string): Promise<"allow" | "deny" | "pending">;
    saveTrust?(
        projectPath: string,
        decision: "always" | "deny"
    ): Promise<void>;
}

export interface CreateHookRuntimeOptions {
    storage: PillarStorageLayout;
    cwd: string;
    hooks: ResolvedHookSettings;
    childEnvironment: ChildProcessEnvironment;
    headless?: boolean;
    signal?: AbortSignal;
    promptExecutor?: HookPromptExecutor;
    requestTrust?: (request: HookTrustRequest) => Promise<"once" | "always" | "deny">;
}

class HookWorkspaceNotTrustedError extends Error {
    constructor(projectPath: string) {
        super(
            `工作区尚未信任，不能在 Headless 模式执行 Hooks: ${projectPath}。请先在该目录交互启动 pillar 并确认信任。`
        );
        this.name = "HookWorkspaceNotTrustedError";
    }
}

function boundedCommand(command: string): string {
    const oneLine = command.replace(/\s+/g, " ").trim();
    return oneLine.length <= MAX_DIAGNOSTIC_COMMAND_LENGTH
        ? oneLine
        : `${oneLine.slice(0, MAX_DIAGNOSTIC_COMMAND_LENGTH - 1)}…`;
}

function queryForHook(input: HookInput): string | undefined {
    switch (input.hook_event_name) {
        case "PreToolUse":
        case "PostToolUse":
        case "PostToolUseFailure":
            return input.tool_name;
        case "SessionStart":
            return input.source;
        case "SessionEnd":
            return input.reason;
        case "UserPromptSubmit":
            return undefined;
    }
}

function validateOutputForEvent(
    event: HookInput["hook_event_name"],
    output: HookJSONOutput
): string | undefined {
    if (output.updatedInput !== undefined && event !== "PreToolUse") {
        return `updatedInput 只允许用于 PreToolUse，当前事件为 ${event}`;
    }
    if (
        output.decision === "block" &&
        event !== "PreToolUse" &&
        event !== "UserPromptSubmit"
    ) {
        return `decision=block 只允许用于 PreToolUse/UserPromptSubmit，当前事件为 ${event}`;
    }
    if (output.additionalContext !== undefined && event === "SessionEnd") {
        return "SessionEnd 不接受 additionalContext";
    }
    return undefined;
}

function hookTrustSummaries(hooks: ResolvedHookSettings) {
    return Object.entries(hooks).flatMap(([event, matchers]) =>
        matchers.flatMap((matcher) =>
            matcher.hooks.map((hook) => ({
                event: event as HookInput["hook_event_name"],
                type: hook.type,
                ...(matcher.matcher ? {matcher: matcher.matcher} : {}),
                ...(hook.if ? {condition: hook.if} : {}),
                ...(hook.once ? {once: true} : {}),
                ...(hook.type === "command"
                    ? {
                        command: hook.command,
                        ...(hook.shell ? {shell: hook.shell} : {}),
                    }
                    : {prompt: hook.prompt}),
                source: matcher.source,
                path: matcher.path,
            }))
        )
    );
}

function disabledRuntime(issues: HookRuntimeIssue[]): HookRuntime {
    return {
        enabled: false,
        issues,
        async execute() {
            return {
                blocked: false,
                additionalContexts: [],
                executions: [],
            };
        },
    };
}

function hookHandler(hook: HookSettings): string {
    return hook.type === "command" ? hook.command : `prompt: ${hook.prompt}`;
}

class ConfiguredHookRuntime implements HookRuntime {
    readonly enabled = true;
    readonly issues: readonly HookRuntimeIssue[] = [];

    constructor(
        private readonly cwd: string,
        private readonly hooks: ResolvedHookSettings,
        private readonly executeCommand: ExecuteHookCommand,
        private readonly childEnvironment: ChildProcessEnvironment,
        private readonly promptExecutor?: HookPromptExecutor
    ) {}

    async execute(
        input: HookInput,
        signal: AbortSignal,
        context?: HookExecutionContext
    ): Promise<HookBatchResult> {
        const executions: HookExecution[] = [];
        const additionalContexts: string[] = [];
        let blocked = false;
        let blockReason: string | undefined;
        let updatedInput = input.hook_event_name === "PreToolUse"
            ? input.tool_input
            : undefined;
        const query = queryForHook(input);
        const matchers = this.hooks[input.hook_event_name]
            .map((matcher, index) => ({matcher, index}))
            .filter(({matcher}) => matchesHookMatcher(query, matcher.matcher));
        const finish = (): HookBatchResult => ({
            blocked,
            ...(blockReason ? {blockReason} : {}),
            ...(updatedInput ? {updatedInput} : {}),
            additionalContexts,
            executions,
        });

        for (const {matcher, index: matcherIndex} of matchers) {
            for (let hookIndex = 0; hookIndex < matcher.hooks.length; hookIndex += 1) {
                const hook = matcher.hooks[hookIndex]!;
                const onceKey = `${input.hook_event_name}:${matcherIndex}:${hookIndex}`;
                const identity = {
                    event: input.hook_event_name,
                    source: matcher.source,
                    type: hook.type,
                    handler: hookHandler(hook),
                } as const;
                if (signal.aborted) {
                    executions.push({
                        ...identity,
                        outcome: "interrupted",
                        durationMs: 0,
                        message: "Hook 执行已取消",
                    });
                    return finish();
                }

                const effectiveInput = input.hook_event_name === "PreToolUse"
                    ? {...input, tool_input: updatedInput ?? input.tool_input}
                    : input;
                if (hook.if) {
                    if (
                        effectiveInput.hook_event_name !== "PreToolUse" &&
                        effectiveInput.hook_event_name !== "PostToolUse" &&
                        effectiveInput.hook_event_name !== "PostToolUseFailure"
                    ) {
                        executions.push({
                            ...identity,
                            outcome: "error",
                            durationMs: 0,
                            message: "Hook if 只允许用于 Tool 事件",
                        });
                        continue;
                    }
                    if (!context?.matchesToolCondition) {
                        executions.push({
                            ...identity,
                            outcome: "error",
                            durationMs: 0,
                            message: "Tool Hook 缺少 if 匹配上下文，已安全跳过",
                        });
                        continue;
                    }
                    let matches = false;
                    try {
                        matches = await context.matchesToolCondition(
                            hook.if,
                            effectiveInput.tool_input
                        );
                    } catch (error) {
                        executions.push({
                            ...identity,
                            outcome: "error",
                            durationMs: 0,
                            message: boundedHookMessage(
                                `Hook if 匹配失败: ${error instanceof Error ? error.message : String(error)}`
                            ),
                        });
                        continue;
                    }
                    if (!matches) continue;
                }
                if (signal.aborted) {
                    executions.push({
                        ...identity,
                        outcome: "interrupted",
                        durationMs: 0,
                        message: "Hook 执行已取消",
                    });
                    return finish();
                }
                if (hook.once) {
                    // `if` 匹配可能 yield；并发 Tool Hook 在恢复后必须再做一次
                    // 原子的 check-and-set，否则两个调用都会消耗同一 once。
                    if (!context?.session) {
                        executions.push({
                            ...identity,
                            outcome: "error",
                            durationMs: 0,
                            message: "once Hook 缺少 Session Runtime，已安全跳过",
                        });
                        continue;
                    }
                    if (!context.session.claimOnce(onceKey)) continue;
                }
                const handled = hook.type === "command"
                    ? await executeCommandHook({
                        event: input.hook_event_name,
                        source: matcher.source,
                        hook,
                        cwd: this.cwd,
                        input: effectiveInput,
                        signal,
                        executeCommand: this.executeCommand,
                        environment: mergeChildProcessEnvironment(
                            this.childEnvironment,
                            {PILLAR_PROJECT_DIR: this.cwd}
                        ),
                    })
                    : await executePromptHook({
                        event: input.hook_event_name,
                        source: matcher.source,
                        hook,
                        input: effectiveInput,
                        signal,
                        executor: this.promptExecutor,
                    });
                if (handled.interrupted) {
                    executions.push(handled.execution);
                    return finish();
                }
                if (!handled.output) {
                    executions.push(handled.execution);
                    continue;
                }
                const semanticError = validateOutputForEvent(
                    input.hook_event_name,
                    handled.output
                );
                if (semanticError) {
                    executions.push({
                        ...handled.execution,
                        outcome: "error",
                        message: semanticError,
                    });
                    continue;
                }
                if (handled.output.decision === "block") {
                    const reason = handled.output.reason ?? "Hook 阻止了操作";
                    blocked = true;
                    blockReason ??= reason;
                }
                if (handled.output.updatedInput) {
                    updatedInput = handled.output.updatedInput;
                }
                if (handled.output.additionalContext) {
                    const used = additionalContexts.reduce(
                        (total, context) => total + context.length,
                        0
                    );
                    const remaining = MAX_TOTAL_CONTEXT_CHARS - used;
                    if (remaining > 0) {
                        additionalContexts.push(
                            handled.output.additionalContext.slice(0, remaining)
                        );
                    }
                }
                executions.push(handled.execution);
            }
        }

        return finish();
    }
}

export function createHookRuntimeFactory(
    overrides: Partial<HookRuntimeDependencies> = {}
) {
    const dependencies: HookRuntimeDependencies = {
        executeCommand: overrides.executeCommand ?? defaultExecuteHookCommand,
        canonicalProjectPath:
            overrides.canonicalProjectPath ?? canonicalHookProjectPath,
        getTrust: overrides.getTrust,
        saveTrust: overrides.saveTrust,
    };

    return async function createHookRuntime(
        options: CreateHookRuntimeOptions
    ): Promise<HookRuntime> {
        if (countResolvedHooks(options.hooks) === 0) {
            return new ConfiguredHookRuntime(
                options.cwd,
                options.hooks,
                dependencies.executeCommand,
                options.childEnvironment,
                options.promptExecutor
            );
        }
        const trustPath = getHookTrustPath(options.storage);
        const readTrust = dependencies.getTrust ??
            ((projectPath: string) => getHookTrust(trustPath, projectPath));
        const writeTrust = dependencies.saveTrust ??
            ((projectPath: string, decision: "always" | "deny") =>
                saveHookTrust(trustPath, projectPath, decision));
        const projectPath = await dependencies.canonicalProjectPath(options.cwd);
        const stored = await readTrust(projectPath);
        if (stored === "allow") {
            return new ConfiguredHookRuntime(
                options.cwd,
                options.hooks,
                dependencies.executeCommand,
                options.childEnvironment,
                options.promptExecutor
            );
        }
        if (options.headless) {
            throw new HookWorkspaceNotTrustedError(projectPath);
        }
        if (stored === "deny") {
            return disabledRuntime([{
                severity: "warning",
                message: `工作区未受信任，Hooks 已禁用: ${projectPath}`,
            }]);
        }
        if (options.signal?.aborted) {
            return disabledRuntime([{
                severity: "warning",
                message: "运行时初始化已取消，Hooks 未启用",
            }]);
        }
        if (!options.requestTrust) {
            return disabledRuntime([{
                severity: "warning",
                message: `没有可用的工作区信任确认器，Hooks 已禁用: ${projectPath}`,
            }]);
        }
        const decision = await options.requestTrust({
            projectPath,
            hooks: hookTrustSummaries(options.hooks),
        });
        if (decision === "always" || decision === "deny") {
            await writeTrust(projectPath, decision);
        }
        if (decision === "deny") {
            return disabledRuntime([{
                severity: "warning",
                message: `用户未信任当前工作区，Hooks 已禁用: ${projectPath}`,
            }]);
        }
        return new ConfiguredHookRuntime(
            options.cwd,
            options.hooks,
            dependencies.executeCommand,
            options.childEnvironment,
            options.promptExecutor
        );
    };
}

export const createHookRuntime = createHookRuntimeFactory();

function formatHookExecutionIssue(execution: HookExecution): string {
    const detail = execution.message
        ? `: ${boundedHookMessage(execution.message)}`
        : "";
    return `${execution.event} ${execution.type} Hook [${boundedCommand(execution.handler)}] ${execution.outcome}${detail}`;
}

export function getHookExecutionIssues(
    result: HookBatchResult
): string[] {
    return result.executions
        .filter((execution) => execution.outcome === "error")
        .map(formatHookExecutionIssue);
}

export function didRunCommandHook(result: HookBatchResult): boolean {
    return result.executions.some(
        (execution) => execution.type === "command" && execution.commandInvoked === true
    );
}

export function formatHookContext(
    event: HookInput["hook_event_name"],
    contexts: readonly string[]
): string[] {
    return contexts.map(
        (context) =>
            `<system-reminder>\n` +
            `Hook ${event} provided the following additional context:\n` +
            `${context}\n` +
            `</system-reminder>`
    );
}
