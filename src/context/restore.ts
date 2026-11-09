import {createHash, randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {contentText} from "../images/content.js";
import {executeToolCallBatch, type ToolExecutor} from "../agent/toolBatch.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message, ToolCall} from "../llm/types.js";
import type {FileReadReceipt} from "../tools/files/receipt.js";
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

/** Select the longest prefix that fits, including its continuation notice. */
function fitPrefix(length: number, render: (length: number) => string, fits: (text: string) => boolean): string | undefined {
    if (fits(render(length))) return render(length);
    if (!fits(render(0))) return undefined;
    let low = 0, high = length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(render(middle))) low = middle;
        else high = middle - 1;
    }
    return render(low);
}

function fitText(text: string, fits: (text: string) => boolean, notice: string): string | undefined {
    if (fits(text)) return text;
    // Keep resource-path guidance intact and close a truncated Hook reminder.
    const sourceEnd = text.startsWith("<skill-source>") ? text.indexOf("</skill-source>") : -1;
    const minimum = sourceEnd < 0 ? 0 : sourceEnd + "</skill-source>".length;
    const closing = text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>") ? "\n</system-reminder>" : "";
    const body = closing ? text.slice(0, -"</system-reminder>".length) : text;
    return fitPrefix(body.length - minimum, count => {
        let end = minimum + count;
        // Do not split a UTF-16 surrogate pair when a single line exceeds the budget.
        if (end > minimum && /[\uD800-\uDBFF]/.test(body[end - 1]!)) end--;
        return `${body.slice(0, end)}\n\n[${notice}]${closing}`;
    }, fits);
}

function fitFile(text: string, receipt: FileReadReceipt, fits: (text: string) => boolean): string | undefined {
    if (fits(text)) return text;
    const header = text.slice(0, receipt.contentStart);
    if (createHash("sha256").update(header).digest("hex") !== receipt.headerHash) return undefined;
    const lines = text.slice(receipt.contentStart).split("\n").slice(0, receipt.end - receipt.start + 1);
    if (lines.length !== receipt.end - receipt.start + 1 ||
        lines.some((line, index) => !line.startsWith(`${String(receipt.start + index).padStart(6, " ")}\t`))) return undefined;
    return fitPrefix(lines.length, count => {
        const end = receipt.start + count - 1;
        const range = count ? `${receipt.start}-${end}` : "none";
        const adjusted = header.replace(/\nLine range: \d+-\d+ \/ \d+\n\n$/, `\nLine range: ${range} / ${receipt.total}\n\n`);
        const next = end + 1;
        const notice = next <= receipt.total
            ? `Restoration budget reached; remaining output omitted. Continue with read_file path=${JSON.stringify(receipt.path)}, offset=${next}.`
            : "Additional tool/Hook output omitted due to restoration budget; all source lines from this read are shown.";
        return adjusted + lines.slice(0, count).join("\n") + `\n\n[${notice}]`;
    }, fits);
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
        const omitted = {role: "tool", tool_call_id: call.id, content: "No complete restoration excerpt fits the budget. Read it explicitly if needed."} as const;
        const hookNotice = {role: "user", origin: "runtime", content: "[PostToolBatch Hook context omitted due to restoration budget.]"} as const;
        const minimumTokens = tokenCountWithEstimation([...group, omitted, hookNotice]);
        if (minimumTokens > RESULT_TOKENS || usedTokens + minimumTokens > RESTORE_TOKENS || !fits([...history, ...group, omitted, hookNotice])) continue;
        let receipt: FileReadReceipt | undefined;
        try {
            await executeToolCallBatch({toolCalls: [call], history: group, ctx, turnId: ctx.turnId, onEvent,
                isToolConcurrencySafe: () => false,
                executeTool: async (...args) => {
                    const result = await executeTool(...args);
                    if (result.outcome === "ok" && result.uiData?.type === "file_read") receipt = result.uiData.receipt;
                    return result;
                },
            });
        } finally {
            // Keep paired results on cancellation/errors. Tool content gets priority over batch Hook context.
            const withinBudget = (messages: Message[]) => {
                const tokens = tokenCountWithEstimation(messages);
                return usedTokens + tokens <= RESTORE_TOKENS && tokens <= RESULT_TOKENS && fits([...history, ...messages]);
            };
            const result = group.find(message => message.role === "tool");
            if (!result || result.role !== "tool") throw new Error("Context restoration has no paired tool result");
            const hooks = group.filter(message => message.role === "user");
            let accepted = group;
            let delivered = result.content;
            if (!withinBudget(group)) {
                const canFit = (content: string) => withinBudget([group[0]!, {...result, content}, ...(hooks.length ? [hookNotice] : [])]);
                const text = contentText(result.content);
                delivered = (receipt ? fitFile(text, receipt, canFit)
                    : fitText(text, canFit, "Restoration excerpt is incomplete; remaining output omitted due to budget. Read the tool/Skill explicitly for full content.")) ?? omitted.content;
                accepted = [group[0]!, {...result, content: delivered}];
                if (hooks.length) {
                    const text = hooks.map(message => contentText(message.content)).join("\n\n");
                    const content = fitText(text, content => withinBudget([...accepted, {...hookNotice, content}]),
                        "PostToolBatch Hook context is incomplete; remaining content omitted due to restoration budget.") ?? hookNotice.content;
                    accepted.push({...hookNotice, content});
                }
                // A shortened/reframed read must not preserve a whole-file observation.
                if (delivered !== result.content) ctx.fileState.bindOutput(call.id, contentText(result.content), {modelContent: delivered});
            }
            if (!withinBudget(accepted)) throw new Error("Context restoration exceeded the current request budget");
            history.push(...accepted);
            usedTokens += tokenCountWithEstimation(accepted);
            try {
                if (delivered !== result.content) await onEvent({type: "tool_result_delivery", toolCallId: call.id, status: "failed",
                    outcome: "output_failed", result: contentText(delivered)});
            } finally {await ctx.commitToolBatch?.();}
        }
        throwIfTurnAborted(ctx.signal);
    }
}
