import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {contentText} from "../images/content.js";
import {executeToolCallBatch, type ToolExecutor} from "../agent/toolBatch.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message, ToolCall} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import {tokenCountWithEstimation} from "./tokens.js";

type RestoreTarget = {name: "read_file" | "skill"; key: string; arguments: string};
const RESTORE_TOKENS = 20_000;
const RESULT_TOKENS = 5_000;

/** Historical calls are discovery hints only. Current scoped execution rechecks access and content. */
function recentTargets(history: readonly Message[], ctx: ToolContext): RestoreTarget[] {
    const results = new Map(history.flatMap(message => message.role === "tool" ? [[message.tool_call_id, contentText(message.content)] as const] : []));
    const seen = new Set<string>();
    const targets: RestoreTarget[] = [];
    for (const message of [...history].reverse()) {
        if (message.role !== "assistant") continue;
        for (const call of [...message.tool_calls ?? []].reverse()) {
            const name = call.function.name;
            if (name !== "read_file" && name !== "skill") continue;
            const output = results.get(call.id);
            if (!output || !(name === "read_file" ? output.startsWith("File: ") && /\nLine range: \d+-\d+/.test(output) : output.startsWith("<skill-source>"))) continue;
            const tool = ctx.availableTools.find(tool => tool.name === name && !tool.mcp);
            if (!tool) continue;
            let raw: unknown;
            try { raw = JSON.parse(call.function.arguments); } catch { continue; }
            const parsed = tool.parameters.safeParse(raw);
            if (!parsed.success || typeof raw !== "object" || raw === null) continue;
            let args: Record<string, unknown>;
            let key: string;
            if (name === "read_file") {
                if (!("path" in raw) || typeof raw.path !== "string") continue;
                const path = resolve(ctx.cwd, raw.path);
                const offset = "offset" in raw && typeof raw.offset === "number" ? raw.offset : 1;
                const limit = "limit" in raw && typeof raw.limit === "number" ? Math.min(raw.limit, 200) : 200;
                args = {path, offset, limit};
                key = `file:${path}`;
            } else {
                if (!("skill" in raw) || typeof raw.skill !== "string" || !ctx.skills.some(skill => skill.name === raw.skill)) continue;
                args = {skill: raw.skill, ...("args" in raw && typeof raw.args === "string" ? {args: raw.args} : {})};
                key = `skill:${raw.skill}`;
            }
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push({name, key, arguments: JSON.stringify(args)});
        }
    }
    return targets;
}

/** Session capability: reuse the same scoped executor, events, Hook and result-budget chain as normal tools. */
export async function restoreCompactedContext(input: {
    previous: readonly Message[];
    history: Message[];
    ctx: ToolContext;
    executeTool: ToolExecutor;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    fits(messages: Message[]): boolean;
}): Promise<void> {
    const {previous, history, ctx, executeTool, onEvent, fits} = input;
    const retained = new Set(recentTargets(history, ctx).map(target => target.key));
    let files = 0, skills = 0, usedTokens = 0;
    for (const target of recentTargets(previous, ctx)) {
        if (retained.has(target.key)) continue;
        if (target.name === "read_file" ? files >= 3 : skills >= 2) continue;
        if (target.name === "read_file") files++; else skills++;
        throwIfTurnAborted(ctx.signal);
        const call: ToolCall = {id: `restore-${randomUUID()}`, type: "function", function: {name: target.name, arguments: target.arguments}};
        const group: Message[] = [{role: "assistant", content: "Reloading recent context after compaction.", tool_calls: [call]}];
        const omitted = {role: "tool", tool_call_id: call.id, content: "Context restoration output (including any Hook context) omitted due to budget. Read it explicitly if needed."} as const;
        const minimumTokens = tokenCountWithEstimation([...group, omitted]);
        if (minimumTokens > RESULT_TOKENS || usedTokens + minimumTokens > RESTORE_TOKENS || !fits([...history, ...group, omitted])) continue;
        try {
            await executeToolCallBatch({toolCalls: [call], history: group, ctx, turnId: ctx.turnId, onEvent,
                isToolConcurrencySafe: () => false,
                executeTool,
            });
        } finally {
            // Keep complete tool evidence even if an event/Hook fails after execution.
            const paired = group.filter(message => message.role === "assistant" || message.role === "tool");
            const withinBudget = (messages: Message[]) => usedTokens + tokenCountWithEstimation(messages) <= RESTORE_TOKENS &&
                tokenCountWithEstimation(messages) <= RESULT_TOKENS && fits([...history, ...messages]);
            let accepted = group;
            if (!withinBudget(accepted)) {
                // Never turn omitted file bytes into delivered read evidence. This also bounds
                // executor failures and PostToolBatch output.
                for (const message of paired) {
                    if (message.role !== "tool") continue;
                    ctx.fileState.bindOutput(message.tool_call_id, contentText(message.content), {modelContent: omitted.content});
                }
                accepted = [group[0]!, omitted];
            }
            if (!withinBudget(accepted)) throw new Error("Context restoration exceeded the current request budget");
            history.push(...accepted);
            usedTokens += tokenCountWithEstimation(accepted);
            try {
                if (accepted !== group) await onEvent({type: "tool_result_delivery", toolCallId: call.id, status: "failed",
                    outcome: "output_failed", result: omitted.content});
            } finally {await ctx.commitToolBatch?.();}
        }
        throwIfTurnAborted(ctx.signal);
    }
}
