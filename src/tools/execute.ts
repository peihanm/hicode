import {toolFileChanges} from "../fileChanges/index.js";
import {requestApproval, type ApprovalResolution} from "../permissions/approval.js";
import {appendContentText, contentText} from "../images/content.js";
import {HookControlError,  formatHookContext, getHookExecutionIssues, type HookBatchResult, type ToolHookRuntime,} from "../hooks/index.js";
import {matchesToolPermissionRule, resolvePermission, type PermissionDecision,} from "../permissions/index.js";
import {isTurnInterruptedError, normalizeTurnAbortReason,} from "../runtime/abort.js";
import {
    createPreview,
    DEFAULT_DISPLAY_CHARS,
    processToolOutput,
    type ToolExecutionResult,
    type ToolOutcome,
} from "../toolResults/index.js";
import {ToolInputError, type Tool, type ToolContext} from "./types.js";
import {resolveFilePermissionPath} from "../permissions/filePattern.js";
import {toolPathInput} from "../permissions/pathGuard.js";

export function formatInterruptedToolResult(signal: AbortSignal): string {
    return `Tool call cancelled (${normalizeTurnAbortReason(signal.reason)})`;
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
    hooks?: ToolHookRuntime
): Promise<ToolExecutionResult> {
    if (ctx.signal.aborted) {
        return interruptedToolResult(ctx.signal);
    }
    const tool = toolMap.get(name);
    if (!tool) return inlineToolResult(`Unknown tool: ${name}`, "failed");

    let rawArgs: unknown;
    try {
        rawArgs = JSON.parse(argsJson || "{}");
    } catch {
        return inlineToolResult(`Tool arguments are not valid JSON: ${argsJson}`, "failed");
    }

    const parsed = tool.parameters.safeParse(rawArgs);
    if (!parsed.success) {
        return inlineToolResult(`Argument validation failed: ${parsed.error.message}`, "failed");
    }
    let input = parsed.data;
    let userAnswers: Readonly<Record<string, string>> | undefined;
    let permissionApproved: true | undefined;
    let preHookResult: HookBatchResult | undefined;

    if (hooks?.enabled) {
        preHookResult = await hooks.execute(
            {
                hook_event_name: "PreToolUse",
                session_id: ctx.sessionId, turn_id: ctx.turnId,
                permission_mode: ctx.permissionMode,
                tool_name: name,
                tool_input: input as Record<string, unknown>,
                tool_call_id: toolCallId,
            },
            ctx.signal,
            {
                matchesToolCondition: (condition, toolInput) =>
                    matchesToolPermissionRule(tool, toolInput, condition, ctx.cwd),
                session: ctx.hookSession, store: ctx.toolResultStore, onEvent: ctx.onHookEvent,
            }
        );
        if (ctx.signal.aborted) {
            return interruptedToolResult(ctx.signal);
        }
        if (preHookResult.error) throw new HookControlError(preHookResult.error);
        if (preHookResult.blocked) {
            return hookDecoratedResult(
                inlineToolResult(
                    `PreToolUse Hook blocked the tool call: ${preHookResult.blockReason ?? "No reason provided"}`,
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
                        `Arguments modified by PreToolUse Hook failed validation: ${reparsed.error.message}`,
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
    const approvalEpoch = ctx.approvalEpoch.signal;
    const executionMode = ctx.permissionMode;
    const collaborationMode = ctx.collaborationMode;
    let authorizedPath: string | undefined;
    const inputPath = toolPathInput(name, input);
    try {
        if (inputPath !== undefined) authorizedPath = await resolveFilePermissionPath(ctx.cwd, inputPath);
        permission = await resolvePermission(tool, input, ctx);
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) {
            return interruptedToolResult(ctx.signal);
        }
        return hookDecoratedResult(
            inlineToolResult(
                error instanceof ToolInputError ? error.message :
                    `Tool execution error: permission check failed: ${error instanceof Error ? error.message : String(error)}`,
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
            inlineToolResult(`Permission denied: ${permission.message}`, "denied"),
            "PreToolUse",
            preHookResult
        );
    }
    if (permission.behavior === "ask") {
        let decision: PermissionDecision;
        let resolution: ApprovalResolution;
        try {
            resolution = await requestApproval(
                ctx, name, input, permission.message, toolCallId,
                {
                    allowPersistent: permission.allowPersistent,
                    presentation: permission.presentation,
                }
            );
            decision = resolution.decision;
        } catch (error) {
            if (approvalEpoch.aborted && !ctx.signal.aborted) return inlineToolResult("Mode or permissions changed during approval; invoke the tool again", "denied");
            if (isTurnInterruptedError(error, ctx.signal)) {
                return interruptedToolResult(ctx.signal);
            }
            return hookDecoratedResult(
                inlineToolResult(
                    `Tool execution error: permission interaction failed: ${error instanceof Error ? error.message : String(error)}`,
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
                inlineToolResult(`${resolution.source === "auto-review" ? "Automatic review denied" : "Approval denied"}${resolution.code ? ` [${resolution.code}]` : ""}: ${decision.message}`, "denied"),
                "PreToolUse",
                preHookResult
            );
        }
        if (decision.behavior !== "allow") {
            return inlineToolResult("Permission interaction did not return a valid allow/deny decision", "denied");
        }
        if (Object.keys(decision).some(key => !["behavior", "answers", "directoryScope", "networkScope"].includes(key))) {
            return inlineToolResult("Permission interaction cannot modify tool input or return unknown fields", "denied");
        }
        if (decision.answers !== undefined) {
            if (tool.acceptsUserAnswers !== true || decision.directoryScope !== undefined || decision.networkScope !== undefined) {
                return hookDecoratedResult(
                    inlineToolResult(`Tool ${name} does not accept user answers in this request`, "denied"),
                    "PreToolUse", preHookResult
                );
            }
            userAnswers = decision.answers;
        }
        if (decision.networkScope !== undefined) {
            return hookDecoratedResult(
                inlineToolResult("Network authorization cannot approve tool execution", "denied"),
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
                            `Directory authorization failed: ${error instanceof Error ? error.message : String(error)}`,
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
                    "Permission interaction returned a directory grant that does not apply to this request",
                    "denied"
                ),
                "PreToolUse",
                preHookResult
            );
        }
    }

    // A policy allow is authorization too, including the normal workspace scope.
    permissionApproved = true;


    let result;
    try {
        if (inputPath !== undefined && await resolveFilePermissionPath(ctx.cwd, inputPath) !== authorizedPath) {
            return inlineToolResult("File target changed during the permission check; invoke the tool again", "denied");
        }
        if (approvalEpoch.aborted) return inlineToolResult("Mode or permissions changed during approval; invoke the tool again", "denied");
        if (ctx.approvalBudget.stopped) return inlineToolResult(ctx.approvalBudget.stopMessage, "denied");
        result = await tool.execute(input, {...ctx, permissionMode: executionMode, collaborationMode}, {toolCallId, ...(userAnswers ? {userAnswers} : {}), ...(permissionApproved ? {permissionApproved} : {})});
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) {
            return interruptedToolResult(ctx.signal);
        }
        const failed = inlineToolResult(
            `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
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
    // its result was being recorded. Do not erase its FileChange.
    const committedFile = typeof result !== "string" && toolFileChanges(result.uiData).length > 0;
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
    const decorated = hookDecoratedResult(
        hookDecoratedResult(processed, "PreToolUse", preHookResult),
        postEvent,
        postHookResult
    );
    ctx.fileState.bindOutput(toolCallId, typeof result === "string" ? result : contentText(result.content), {...decorated, modelContent: contentText(decorated.modelContent)});
    return decorated;
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
    hooks?: ToolHookRuntime;
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
        session_id: ctx.sessionId, turn_id: ctx.turnId,
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
                content: contentText(result.modelContent),
                ...(persisted ? {persisted} : {}),
            },
        }
        : {
            hook_event_name: "PostToolUseFailure" as const,
            ...common,
            tool_response: {
                outcome: "failed" as const,
                content: contentText(result.modelContent),
                ...(persisted ? {persisted} : {}),
            },
        };
    const hookResult = await hooks.execute(hookInput, ctx.signal, {
        matchesToolCondition: (condition, toolInput) =>
            matchesToolPermissionRule(tool, toolInput, condition, ctx.cwd),
        session: ctx.hookSession, store: ctx.toolResultStore, onEvent: ctx.onHookEvent,
    });
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
            ? appendContentText(result.modelContent, contexts.join("\n\n"))
            : result.modelContent,
        displayContent: issues.length > 0
            ? `${result.displayContent}\n\nHook warning:\n ${issues.map((issue) => `- ${issue}`).join("\n")}`
            : result.displayContent,
    };
}
