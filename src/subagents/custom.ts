import type {PermissionMode} from "../permissions/index.js";
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
    parentMode: PermissionMode
): PermissionMode {
    return parentMode === "default" ? "dontAsk" : parentMode;
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
                    lspManager: parentContext.lspManager,
                    gitSession: parentContext.gitSession,
                    shellRunner: parentContext.shellRunner,
                },
                permissionRules: {
                    allow: [...parentContext.permissionRules.allow],
                    ask: [...parentContext.permissionRules.ask],
                    deny: [...parentContext.permissionRules.deny],
                },
                permissionMode: customAgentPermissionMode(
                    parentContext.permissionMode
                ),
                prePlanMode: parentContext.prePlanMode,
            };
        },
    };
}
