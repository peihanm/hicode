import {didRunCommandHook, formatHookContext, getHookExecutionIssues, type HookBatchResult, type HookRuntime,} from "../hooks/index.js";
import {matchesToolPermissionRule, resolvePermission, type PermissionDecision,} from "../permissions/index.js";
import {isTurnInterruptedError, normalizeTurnAbortReason,} from "../runtime/abort.js";
import {
    createPreview,
    DEFAULT_DISPLAY_CHARS,
    processToolOutput,
    type ToolExecutionResult,
    type ToolOutcome,
} from "../toolResults/index.js";
import type {Tool, ToolContext} from "./types.js";

export function formatInterruptedToolResult(signal: AbortSignal): string {
    return `工具调用已取消（${normalizeTurnAbortReason(signal.reason)}）`;
}

export function inlineToolResult(
    content: string,
    outcome: ToolOutcome
): ToolExecutionResult {
    return {
        modelContent: content,
        displayContent: createPreview(content, DEFAULT_DISPLAY_CHARS),
        outcome,
    };
}

function interruptedToolResult(signal: AbortSignal): ToolExecutionResult {
    return inlineToolResult(formatInterruptedToolResult(signal), "interrupted");
}

export function isToolConcurrencySafe(
    toolMap: ReadonlyMap<string, Tool>,
    name: string,
    argsJson: string
): boolean {
    const tool = toolMap.get(name);
    if (!tool?.isConcurrencySafe) return false;
    try {
        const parsed = tool.parameters.safeParse(JSON.parse(argsJson || "{}"));
        return parsed.success && Boolean(tool.isConcurrencySafe(parsed.data));
    } catch {
        return false;
    }
}

export async function executeRegisteredTool(
    toolMap: ReadonlyMap<string, Tool>,
    name: string,
    argsJson: string,
    ctx: ToolContext,
    toolCallId: string,
    hooks?: HookRuntime
): Promise<ToolExecutionResult> {
    if (ctx.signal.aborted) {
        return interruptedToolResult(ctx.signal);
    }
    const tool = toolMap.get(name);
    if (!tool) return inlineToolResult(`未知工具: ${name}`, "failed");

    let rawArgs: unknown;
    try {
        rawArgs = JSON.parse(argsJson || "{}");
    } catch {
        return inlineToolResult(`工具参数不是合法 JSON: ${argsJson}`, "failed");
    }

    const parsed = tool.parameters.safeParse(rawArgs);
    if (!parsed.success) {
        return inlineToolResult(`参数校验失败: ${parsed.error.message}`, "failed");
    }
    let input = parsed.data;
    let userAnswers: Readonly<Record<string, string>> | undefined;
    let userApproved: true | undefined;
    let preHookResult: HookBatchResult | undefined;

    if (hooks?.enabled) {
        preHookResult = await hooks.execute(
            {
                hook_event_name: "PreToolUse",
                session_id: ctx.sessionId,
                permission_mode: ctx.permissionMode,
                tool_name: name,
                tool_input: input as Record<string, unknown>,
                tool_call_id: toolCallId,
            },
            ctx.signal,
            {
                matchesToolCondition: (condition, toolInput) =>
                    matchesToolPermissionRule(tool, toolInput, condition),
                session: ctx.hookSession,
            }
        );
        if (didRunCommandHook(preHookResult)) {
            await ctx.fileCheckpoints.markCoverageWarning({
                code: "hook_side_effects",
                message: "Command Hook 可能产生未被 File Checkpoint 捕获的文件副作用",
            });
        }
        if (ctx.signal.aborted) {
            return interruptedToolResult(ctx.signal);
        }
        if (preHookResult.blocked) {
            return hookDecoratedResult(
                inlineToolResult(
                    `PreToolUse Hook 阻止了工具调用: ${preHookResult.blockReason ?? "未提供原因"}`,
                    "denied"
                ),
                "PreToolUse",
                preHookResult
            );
        }
        if (preHookResult.updatedInput !== undefined) {
            const reparsed = tool.parameters.safeParse(preHookResult.updatedInput);
            if (!reparsed.success) {
                return hookDecoratedResult(
                    inlineToolResult(
                        `PreToolUse Hook 修改后的参数校验失败: ${reparsed.error.message}`,
                        "failed"
                    ),
                    "PreToolUse",
                    preHookResult
                );
            }
            input = reparsed.data;
        }
    }

    if (ctx.signal.aborted) {
        return interruptedToolResult(ctx.signal);
    }

    let permission;
    try {
        permission = await resolvePermission(tool, input, ctx);
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) {
            return interruptedToolResult(ctx.signal);
        }
        return hookDecoratedResult(
            inlineToolResult(
                `工具执行出错: 权限检查失败: ${error instanceof Error ? error.message : String(error)}`,
                "failed"
            ),
            "PreToolUse",
            preHookResult
        );
    }
    if (ctx.signal.aborted) {
        return interruptedToolResult(ctx.signal);
    }
    if (permission.behavior === "deny") {
        return hookDecoratedResult(
            inlineToolResult(`权限拒绝: ${permission.message}`, "denied"),
            "PreToolUse",
            preHookResult
        );
    }
    if (permission.behavior === "ask") {
        let decision: PermissionDecision;
        try {
            decision = await ctx.canUseTool(
                name,
                permission.message,
                structuredClone(input),
                {
                    allowPersistent: permission.allowPersistent,
                    presentation: permission.presentation,
                }
            );
        } catch (error) {
            if (isTurnInterruptedError(error, ctx.signal)) {
                return interruptedToolResult(ctx.signal);
            }
            return hookDecoratedResult(
                inlineToolResult(
                    `工具执行出错: 权限交互失败: ${error instanceof Error ? error.message : String(error)}`,
                    "failed"
                ),
                "PreToolUse",
                preHookResult
            );
        }
        if (ctx.signal.aborted) {
            return interruptedToolResult(ctx.signal);
        }
        if (decision.behavior === "deny") {
            return hookDecoratedResult(
                inlineToolResult(`用户拒绝: ${decision.message}`, "denied"),
                "PreToolUse",
                preHookResult
            );
        }
        if (decision.behavior !== "allow") {
            return inlineToolResult("权限交互没有返回有效的 allow/deny 决定", "denied");
        }
        if (Object.keys(decision).some(key => !["behavior", "answers", "directoryScope", "networkScope"].includes(key))) {
            return inlineToolResult("权限交互不能修改工具输入或返回未知字段", "denied");
        }
        if (decision.answers !== undefined) {
            if (tool.acceptsUserAnswers !== true || decision.directoryScope !== undefined || decision.networkScope !== undefined) {
                return hookDecoratedResult(
                    inlineToolResult(`工具 ${name} 不接收该请求中的用户答案`, "denied"),
                    "PreToolUse", preHookResult
                );
            }
            userAnswers = decision.answers;
        }
        if (decision.networkScope !== undefined) {
            return hookDecoratedResult(
                inlineToolResult("网络授权不能用于批准工具执行", "denied"),
                "PreToolUse",
                preHookResult
            );
        }
        if (permission.presentation?.kind === "filesystem_access") {
            const scope = decision.directoryScope ?? "once";
            if (scope !== "once") {
                try {
                    await ctx.directoryAccess.grantDirectory(
                        permission.presentation.suggestedDirectory,
                        scope
                    );
                } catch (error) {
                    return hookDecoratedResult(
                        inlineToolResult(
                            `目录授权失败: ${error instanceof Error ? error.message : String(error)}`,
                            "failed"
                        ),
                        "PreToolUse",
                        preHookResult
                    );
                }
            }
        } else if (decision.directoryScope !== undefined) {
            return hookDecoratedResult(
                inlineToolResult(
                    "权限交互返回了不适用于当前请求的目录授权",
                    "denied"
                ),
                "PreToolUse",
                preHookResult
            );
        }
    }

    if (permission.behavior === "ask") userApproved = true;

    if (name === "bash") {
        await ctx.fileCheckpoints.markCoverageWarning({
            code: "bash_side_effects",
            message: "Bash 可能产生未被 File Checkpoint 捕获的文件副作用",
        });
    } else if (tool.externalSideEffects && tool.isReadOnly?.(input) !== true) {
        const source = tool.externalSideEffects === "mcp" ? "MCP" : "Host Tool";
        await ctx.fileCheckpoints.markCoverageWarning({
            code: tool.externalSideEffects === "mcp"
                ? "mcp_side_effects"
                : "host_tool_side_effects",
            message: `${source} ${name} 未声明只读，可能产生未被 File Checkpoint 捕获的文件副作用`,
        });
    }

    let result;
    try {
        result = await tool.execute(input, ctx, {toolCallId, ...(userAnswers ? {userAnswers} : {}), ...(userApproved ? {userApproved} : {})});
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) {
            return interruptedToolResult(ctx.signal);
        }
        const failed = inlineToolResult(
            `工具执行出错: ${error instanceof Error ? error.message : String(error)}`,
            "failed"
        );
        const postFailureResult = await executePostToolHooks({
            hooks,
            event: "PostToolUseFailure",
            tool,
            name,
            input: input as Record<string, unknown>,
            toolCallId,
            result: failed,
            ctx,
        });
        return hookDecoratedResult(
            hookDecoratedResult(
                failed,
                "PreToolUse",
                preHookResult
            ),
            "PostToolUseFailure",
            postFailureResult
        );
    }

    // A completed file commit is a fact even if the Turn was cancelled while
    // its checkpoint/result was being recorded. Do not erase its FileChange.
    const committedFile = typeof result !== "string" && result.uiData?.type === "file_change";
    if (ctx.signal.aborted && !committedFile) {
        return interruptedToolResult(ctx.signal);
    }
    const processed = await processToolOutput({
        output: result,
        toolName: name,
        toolCallId,
        maxResultSizeChars: tool.maxResultSizeChars,
        store: ctx.toolResultStore,
    });
    if (
        processed.outcome === "ok" &&
        processed.uiData?.type === "file_change"
    ) {
        ctx.gitSession?.observePaths(
            [processed.uiData.change.path],
            ctx.cwd
        );
    }

    const postEvent = processed.outcome === "ok"
        ? "PostToolUse"
        : "PostToolUseFailure";
    const postHookResult = await executePostToolHooks({
        hooks,
        event: postEvent,
        tool,
        name,
        input: input as Record<string, unknown>,
        toolCallId,
        result: processed,
        ctx,
    });
    if (ctx.signal.aborted && !committedFile) {
        return interruptedToolResult(ctx.signal);
    }
    return hookDecoratedResult(
        hookDecoratedResult(processed, "PreToolUse", preHookResult),
        postEvent,
        postHookResult
    );
}

async function executePostToolHooks({
    hooks,
    event,
    tool,
    name,
    input,
    toolCallId,
    result,
    ctx,
}: {
    hooks?: HookRuntime;
    event: "PostToolUse" | "PostToolUseFailure";
    tool: Tool;
    name: string;
    input: Record<string, unknown>;
    toolCallId: string;
    result: ToolExecutionResult;
    ctx: ToolContext;
}): Promise<HookBatchResult | undefined> {
    if (!hooks?.enabled) return undefined;
    const persisted = result.persisted
        ? {
            result_id: result.persisted.resultId,
            byte_length: result.persisted.byteLength,
            complete: result.persisted.complete,
        }
        : undefined;
    const common = {
        session_id: ctx.sessionId,
        permission_mode: ctx.permissionMode,
        tool_name: name,
        tool_input: input,
        tool_call_id: toolCallId,
    };
    const hookInput = event === "PostToolUse"
        ? {
            hook_event_name: "PostToolUse" as const,
            ...common,
            tool_response: {
                outcome: "ok" as const,
                content: result.modelContent,
                ...(persisted ? {persisted} : {}),
            },
        }
        : {
            hook_event_name: "PostToolUseFailure" as const,
            ...common,
            tool_response: {
                outcome: result.outcome === "ok" ? "failed" as const : result.outcome,
                content: result.modelContent,
                ...(persisted ? {persisted} : {}),
            },
        };
    const hookResult = await hooks.execute(hookInput, ctx.signal, {
        matchesToolCondition: (condition, toolInput) =>
            matchesToolPermissionRule(tool, toolInput, condition),
        session: ctx.hookSession,
    });
    if (didRunCommandHook(hookResult)) {
        await ctx.fileCheckpoints.markCoverageWarning({
            code: "hook_side_effects",
            message: `${event} Command Hook 可能产生未被 File Checkpoint 捕获的文件副作用`,
        });
    }
    return hookResult;
}

function hookDecoratedResult(
    result: ToolExecutionResult,
    event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure",
    hookResult?: HookBatchResult
): ToolExecutionResult {
    if (!hookResult) return result;
    const contexts = formatHookContext(event, hookResult.additionalContexts);
    const issues = getHookExecutionIssues(hookResult);
    if (contexts.length === 0 && issues.length === 0) return result;
    return {
        ...result,
        modelContent: contexts.length > 0
            ? `${result.modelContent}\n\n${contexts.join("\n\n")}`
            : result.modelContent,
        displayContent: issues.length > 0
            ? `${result.displayContent}\n\nHook 警告:\n${issues.map((issue) => `- ${issue}`).join("\n")}`
            : result.displayContent,
    };
}
