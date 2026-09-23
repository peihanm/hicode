import type {AgentDefinition} from "./types.js";

export function hasAgentWriteTools(definition: AgentDefinition): boolean {
    return !definition.readOnly && (definition.allowedTools === undefined || definition.allowedTools.some(name => ![
        "read_file", "web_fetch", "agent_message", "view_image", "todo_write", "skill",
    ].includes(name)));
}

export interface SubagentRegistration {
    definition: AgentDefinition;
    concurrencySafe: boolean;
}

export const CUSTOM_AGENT_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
    "agent", "agent_followup", "ask_user", "memory",
]);
