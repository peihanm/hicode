import type {PermissionMode, PermissionPromptPolicy, PermissionRules} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {ToolContextResources} from "../runtime/toolContext.js";
import type {CreateToolRuntimeOptions} from "../tools/runtime.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentDefinition} from "./types.js";

export function hasAgentWriteTools(definition: AgentDefinition): boolean {
    return definition.allowedTools.some(name => ![
        "list_files", "glob", "read_file", "grep", "web_fetch",
    ].includes(name));
}

export interface SubagentRuntimeConfig {
    toolRuntimeOptions: CreateToolRuntimeOptions;
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
