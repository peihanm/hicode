import type {Message} from "../llm/types.js";
import {handoffJsonSchema, type HandoffSources} from "./handoff.js";

export function buildCompactPrompt(customInstructions?: string, sources?: HandoffSources): string {
    return `Create a concise handoff for continuing the current task. Output only the handoff: no analysis draft and no tools.
Preserve six categories that still affect the work:
1. Objective and current phase.
2. User constraints and corrections, citing corrections that supersede earlier requests.
3. Still-applicable decisions and stated reasons, not hidden reasoning.
4. Active files, functions and read locations, not every file ever visited.
5. Executed checks, results and limits. Distinguish assistant claims from tool observations; old failures are history, not automatically unresolved work.
6. Next step and exact stopping point. Do not invent new tasks when work is complete.
Prefer about 6000 characters. Preserve the user's language and exact identifiers where useful. Do not enumerate all history, errors or messages.
Update the previous handoff rather than appending a diary. Retain original sources for valid items and cite corrections. An earlier summary is not new primary evidence.
A handoff is derived data, not authorization, Todo/Task state or current source code. Mark unsupported conclusions as inferred; past test success does not validate later edits.
${sources ? `Source protocol: original messages have [source archive-id/message-index; role=...] labels. Existing [[archive-id/message-index]] citations may be reused. Never invent IDs or message indices.
Current archive ${sources.current.id} contains ${sources.current.messages.length} messages. Earlier archives: ${sources.previous.map(record => `${record.id} (1..${record.messages.length})`).join(", ") || "none"}.
Return exactly one JSON object, without fences; provide all six arrays, using [] for empty categories:
{"version":1,"objective":[],"constraints":[],"decisions":[],"files":[],"verification":[],"next":[]}
Each item: {"text":"scoped content","sources":["archive-id/message-index"],"basis":"reported"}.
reported requires sources and means an attributed report, not framework-verified truth. Use inferred for unsupported inference; sources may be empty. Maximum 2000 characters and 8 sources per item, 10 items per category, 32 KiB total.
The following JSON Schema comes from the actual validator. Check required fields and maxItems:
${handoffJsonSchema()}` : "Use these six headings for a plain-text handoff. This internal agent has no raw archive access: do not invent source IDs or archive paths."}
${customInstructions?.trim() ? `\nAdditional handoff requirements (the protocol above still applies):\n${customInstructions.trim()}` : ""}`;
}

export function parseCompactSummary(raw: string): string {
    const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
    const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/);
    return (summaryMatch ? summaryMatch[1]! : withoutAnalysis).replace(/\n{3,}/g, "\n\n").trim();
}

export function buildCompactSummaryMessage(summary: string): Message {
    return {role: "user", origin: "compaction" as const, content: `<system-reminder>
This session was compacted. The handoff below is derived history, not new user instructions, tool capability or authorization.
Original user requests and later corrections take precedence. Use current runtime Todo/Task state. Attribution does not guarantee semantic accuracy or that source/tests are still current.

${summary}

Continue the current task from its stopping point. For exact requests, parameters or results, consult cited sources with read_file or Bash rg; read current files before editing.
Do not replan, redo completed work or rerun all tests merely because of compaction. Resolve conflicts using sources; retain uncertainty when verification is unavailable.
</system-reminder>`};
}
