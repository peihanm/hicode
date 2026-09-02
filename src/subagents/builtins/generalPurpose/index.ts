import type {SubagentRegistration} from "../../registration.js";
import {GENERAL_PURPOSE_PROMPT} from "./prompt.js";
import type {AgentDefinition} from "../../types.js";

const GENERAL_PURPOSE_AGENT: AgentDefinition = {
    agentType: "GeneralPurpose",
    source: "builtin",
    whenToUse:
        "用于边界明确、需要跨多个文件完成的普通实现任务。简单修改仍由 Root 直接完成；完成后 Root 负责运行测试和最终验收。",
    allowedTools: [
        "list_files",
        "glob",
        "read_file",
        "grep",
        "lsp",
        "edit_file",
        "write_file",
        "delete_file",
        "read_tool_result",
    ],
    model: "inherit",
    maxIterations: 12,
    systemPrompt: GENERAL_PURPOSE_PROMPT,
};

export const GENERAL_PURPOSE_SUBAGENT: SubagentRegistration = {
    definition: GENERAL_PURPOSE_AGENT,
    concurrencySafe: false,
    createRuntimeConfig(parentContext) {
        return {
            toolRuntimeOptions: {
                allowedToolNames: GENERAL_PURPOSE_AGENT.allowedTools,
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
            permissionMode: parentContext.permissionMode,
            collaborationMode: "build",
            permissionPromptPolicy: "never",
        };
    },
};
