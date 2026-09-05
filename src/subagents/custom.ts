import type {PermissionMode} from "../permissions/index.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentDefinition} from "./types.js";
import type {SubagentRegistration} from "./registration.js";

export const CUSTOM_AGENT_FORBIDDEN_TOOLS = new Set([
    "agent",
    "ask_user",
    "enter_plan_mode",
    "exit_plan_mode",
    "todo_write",
    "skill",
    "memory",
    "bash_task",
    "task",
]);

function customAgentPermissionMode(
    parentContext: Pick<
        ToolContext,
        "permissionMode" | "workspaceBoundary" | "permissionPromptPolicy"
    >
): PermissionMode {
    if (parentContext.permissionMode !== "default") {
        return parentContext.permissionMode;
    }
    return parentContext.workspaceBoundary &&
        parentContext.permissionPromptPolicy === "never"
        ? "default"
        : "readOnly";
}

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
                    storage: parentContext.storage,
                    cwd: parentContext.cwd,
                    workspaceBoundary:
                        parentContext.workspaceBoundary ?? parentContext.cwd,
                    skills: [],
                    instructions: parentContext.instructions,
                    gitSession: parentContext.gitSession,
                    shellRunner: parentContext.shellRunner,
                },
                permissionRules: {
                    allow: [...parentContext.permissionRules.allow],
                    ask: [...parentContext.permissionRules.ask],
                    deny: [...parentContext.permissionRules.deny],
                },
                permissionMode: customAgentPermissionMode(
                    parentContext
                ),
                collaborationMode: parentContext.collaborationMode,
                permissionPromptPolicy: "never",
            };
        },
    };
}
