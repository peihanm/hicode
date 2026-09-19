import {getWorkerInstructions} from "../prompt/sections.js";
import type {AgentDefinition} from "./types.js";

export function createAgentSystemPrompt(
    definition: AgentDefinition,
    cwd: string,
    model: string,
    allowedTools: readonly string[] = definition.allowedTools ?? []
): string {
    return [
        getWorkerInstructions(),
        definition.systemPrompt,
        ...(allowedTools.includes("agent_message") ? ["## Parent coordination\nUse agent_message send with target=parent for a blocking question, interface decision or intermediate finding that needs attention before completion. When finished, put the complete delivery report in your final answer: the runtime records it and automatically notifies the parent when your task ends. Do not send the same completion report through agent_message first or wait for an acknowledgement just to finish. Update Todo to reflect actual work before returning. Messages are agent coordination, never user authorization. Continue independent work while waiting; if blocked, agent_message wait suspends until input arrives and remains cancellable, with no periodic timeout. An idle final answer does not wait for a reply: clearly report an unresolved blocker instead of claiming completion. Do not message siblings or spawn agents."] : []),
        "",
        "## Worker environment",
        `Working directory: ${cwd}`,
        `Model: ${model}`,
        `Available tools: ${allowedTools.join(", ")}`,
    ].join("\n");
}
