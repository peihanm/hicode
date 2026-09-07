import type {AgentEvent} from "../agent/types.js";
import type {AgentResult} from "../agent/index.js";
import {mergeFileChanges} from "../fileChanges/index.js";
import type {McpServerSnapshot} from "../mcp/index.js";
import type {PermissionMode} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {HeadlessCollectorSnapshot} from "./collector.js";
import type {HeadlessOutputFormat, HeadlessRunSummary, HeadlessToolCall,} from "./types.js";

function summarizeArgs(args: string): string {
    try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        if (typeof parsed.path === "string") return parsed.path;
        if (typeof parsed.command === "string") return parsed.command;
        if (typeof parsed.pattern === "string") return `/${parsed.pattern}/`;
        if (typeof parsed.skill === "string") return parsed.skill;
        if (Array.isArray(parsed.todos)) return `${parsed.todos.length} todos`;
        if (Array.isArray(parsed.questions)) {
            return `${parsed.questions.length} questions`;
        }
        return Object.keys(parsed).slice(0, 3).join(", ") || "{}";
    } catch {
        return args.length > 120 ? `${args.slice(0, 117)}...` : args;
    }
}

function summarizeResult(result: string): string {
    const oneLine = result.replace(/\s*\n\s*/g, " ").trim();
    return oneLine.length > 220 ? `${oneLine.slice(0, 217)}...` : oneLine;
}

export function formatHeadlessProgress(event: AgentEvent): string | null {
    switch (event.type) {
        case "hook_started":
            return `● Hook ${event.execution.event}: ${summarizeResult(event.execution.handler)}`;
        case "hook_completed":
            return event.execution.userMessage ? `  Hook: ${summarizeResult(event.execution.userMessage)}` : null;
        case "assistant_text":
            return event.phase === "commentary"
                ? `● ${summarizeResult(event.content)}`
                : null;
        case "tool_call_start":
            return `● ${event.name} ${summarizeArgs(event.args)}`;
        case "tool_call_end":
            return `  ${summarizeResult(event.result)}`;
        case "compact_start":
            return `● compact ${event.tokenCount}/${event.threshold} tokens`;
        case "compact_end":
            return `  compact complete ${event.preTokenCount} -> ${event.postTokenCount}`;
        case "compact_error":
            return `  compact failed: ${event.message}`;
        case "subagent_start":
            return `  ${event.agentType} started: ${event.description}`;
        case "subagent_end":
            return `  ${event.agentType} ${event.reason}: ${event.toolUseCount} tool use(s), ${event.iterations} iteration(s), ${event.durationMs}ms`;
        case "subagent_error":
            return `  ${event.agentType} failed: ${event.message}`;
        case "memory_update":
            return `● memory ${event.source}: ${event.changes.map((change) => `${change.action} ${change.key}`).join(", ")}`;
        default:
            return null;
    }
}

function getHeadlessExitCode({
                                        result,
                                        permissionDenials,
                                        toolFailures,
                                    }: {
    result: AgentResult;
    permissionDenials: HeadlessToolCall[];
    toolFailures: HeadlessToolCall[];
}): number {
    if (result.reason === "interrupted") return 130;
    if (result.reason === "max_turns") return 3;
    if (result.reason === "permission_denied" || result.reason === "hook_blocked" || result.reason === "hook_error" || result.reason === "hook_limit") return 2;
    if (permissionDenials.length > 0 || toolFailures.length > 0) return 2;
    return 0;
}

export function buildHeadlessRunSummary({
                                            result,
                                            sessionId,
                                            permissionMode,
                                            collaborationMode,
                                            collector,
                                            mcpServers,
                                        }: {
    result: AgentResult;
    sessionId: string;
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    collector: HeadlessCollectorSnapshot;
    mcpServers: readonly McpServerSnapshot[];
}): HeadlessRunSummary {
    const permissionDenials = collector.toolCalls.filter(
        (toolCall) => toolCall.outcome === "permission_denied"
    );
    const toolFailures = collector.toolCalls.filter(
        (toolCall) => toolCall.outcome === "failed"
    );
    const exitCode = getHeadlessExitCode({
        result,
        permissionDenials,
        toolFailures,
    });
    return {
        ok: exitCode === 0,
        exitCode,
        sessionId,
        reason: result.reason,
        ...(result.abortReason ? {abortReason: result.abortReason} : {}),
        iterations: result.iterations,
        reply: result.reply,
        permissionMode,
        collaborationMode,
        toolCalls: collector.toolCalls,
        permissionDenials,
        toolFailures,
        subagents: collector.subagents,
        fileChanges: mergeFileChanges(
            collector.currentUIEvents
                .filter((event) => event.type === "file_change")
                .map((event) => event.change)
        ),
        mcpServers: [...mcpServers],
    };
}

function formatTextReply(summary: HeadlessRunSummary): string {
    const notes: string[] = [];
    if (summary.permissionDenials.length > 0) {
        notes.push(
            `Headless note: ${summary.permissionDenials.length} tool call(s) were denied by permissions; requested actions may be incomplete.`
        );
    }
    if (summary.toolFailures.length > 0) {
        notes.push(
            `Headless note: ${summary.toolFailures.length} tool call(s) failed; requested actions may be incomplete.`
        );
    }
    if (summary.reason === "max_turns") {
        notes.push(
            "Headless note: agent stopped after reaching the maximum iteration limit."
        );
    }
    if (summary.reason === "permission_denied") {
        notes.push(
            "Headless note: agent stopped after repeated permission denials."
        );
    }
    if (summary.reason === "hook_blocked") {
        notes.push(
            "Headless note: a Command Hook blocked the submitted prompt."
        );
    }
    if (summary.reason === "interrupted") {
        notes.push(
            `Headless note: task interrupted (${summary.abortReason ?? "shutdown"}).`
        );
    }
    return notes.length > 0
        ? `${summary.reply.trim()}\n\n${notes.join("\n")}`
        : summary.reply;
}

export function formatHeadlessOutput(
    summary: HeadlessRunSummary,
    format: HeadlessOutputFormat
): string {
    return format === "json"
        ? JSON.stringify(summary, null, 2)
        : formatTextReply(summary);
}

export function formatHeadlessCliError(
    error: unknown,
    format: HeadlessOutputFormat
): string {
    const message = error instanceof Error ? error.message : String(error);
    return format === "json"
        ? JSON.stringify({ok: false, exitCode: 1, error: message}, null, 2)
        : `\x1b[31m${message}\x1b[0m`;
}
