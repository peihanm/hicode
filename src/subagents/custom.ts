import type {AgentDefinition} from "./types.js";
import type {SubagentRegistration} from "./registration.js";

export const CUSTOM_AGENT_FORBIDDEN_TOOLS = new Set([
    "agent",
    "ask_user",
    "todo_write",
    "skill",
    "memory",
    "task",
]);


export function createCustomSubagentRegistration(
    definition: AgentDefinition
): SubagentRegistration {
    if (definition.source === "builtin") {
        throw new Error("内置 Agent 不能使用通用 Custom Registration");
    }
    return {
        definition,
        concurrencySafe: false,
        createRuntimeConfig(parentContext) {
            const mcpTools = parentContext.mcpManager?.getTools() ?? [];
            return {
                toolRuntimeOptions: {
                    allowedToolNames: definition.allowedTools,
                    additionalTools: mcpTools,
                },
                contextResources: {
                readOnlyTools: !parentContext.workspaceBoundary || parentContext.permissionPromptPolicy !== "never",
                    storage: parentContext.storage,
                    cwd: parentContext.cwd,
                    workspaceBoundary:
                        parentContext.workspaceBoundary ?? parentContext.cwd,
                    skills: [],
                    instructions: parentContext.instructions,
                    shellRunner: parentContext.shellRunner,
                },
                permissionRules: {
                    allow: [...parentContext.permissionRules.allow],
                    ask: [...parentContext.permissionRules.ask],
                    deny: [...parentContext.permissionRules.deny],
                },
                permissionMode: "ask",
                collaborationMode: parentContext.collaborationMode,
                permissionPromptPolicy: "never",
            };
        },
    };
}
