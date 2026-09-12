import {getWorkerInstructions} from "../prompt/sections.js";
import type {AgentDefinition} from "./types.js";

export function createAgentSystemPrompt(
    definition: AgentDefinition,
    cwd: string,
    model: string,
    allowedTools: readonly string[] = definition.allowedTools
): string {
    return [
        getWorkerInstructions(),
        definition.systemPrompt,
        "",
        "## Worker environment",
        `Working directory: ${cwd}`,
        `Model: ${model}`,
        `Available tools: ${allowedTools.join(", ")}`,
    ].join("\n");
}
