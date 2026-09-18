import type {AgentDefinition} from "./types.js";

export function usesFastSubagentModel(definition: AgentDefinition): boolean {
    return definition.source === "builtin" && definition.agentType === "Explore";
}

export function formatSubagentModel(definition: AgentDefinition, fastModel?: string): string {
    return usesFastSubagentModel(definition) ? `Explore model (${fastModel ?? "configured fast model"})` : "Same as main agent";
}
