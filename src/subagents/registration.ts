import type {PermissionMode, PermissionPromptPolicy, PermissionRules} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {ToolContextResources} from "../runtime/toolContext.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentDefinition} from "./types.js";

export function hasAgentWriteTools(definition: AgentDefinition): boolean {
    return !definition.readOnly && (definition.allowedTools === undefined || definition.allowedTools.some(name => ![
        "read_file", "web_fetch", "agent_message", "view_image", "todo_write", "skill",
    ].includes(name)));
}

export interface SubagentRuntimeConfig {
    contextResources: Omit<
        ToolContextResources,
        "model" | "provider" | "fastModel" | "fastProvider" | "fileCommits" | "contextSettings"
    >;
    permissionRules: PermissionRules;
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    permissionPromptPolicy: PermissionPromptPolicy;
}

export interface SubagentRegistration {
    definition: AgentDefinition;
    concurrencySafe: boolean;

    createRuntimeConfig(parentContext: ToolContext): SubagentRuntimeConfig;
}
