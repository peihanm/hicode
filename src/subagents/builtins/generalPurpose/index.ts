import type {SubagentRegistration} from "../../registration.js";
import type {PermissionMode} from "../../../permissions/index.js";
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

function childPermissionMode(parentMode: PermissionMode): PermissionMode {
    // Agent 工具本身已经对写型 child 做过一次启动授权。default 下将
    // child 收敛到 acceptEdits，避免每个文件修改再次请求交互式确认。
    return parentMode === "default" ? "acceptEdits" : parentMode;
}

export const GENERAL_PURPOSE_SUBAGENT: SubagentRegistration = {
    definition: GENERAL_PURPOSE_AGENT,
    concurrencySafe: false,
    createRuntimeConfig(parentContext) {
        return {
            toolRuntimeOptions: {
                allowedToolNames: GENERAL_PURPOSE_AGENT.allowedTools,
            },
            contextResources: {
                cwd: parentContext.cwd,
                workspaceBoundary:
                    parentContext.workspaceBoundary ?? parentContext.cwd,
                skills: [],
                instructions: parentContext.instructions,
                lspManager: parentContext.lspManager,
                fileState: parentContext.fileState,
                gitSession: parentContext.gitSession,
                shellRunner: parentContext.shellRunner,
            },
            permissionRules: {
                allow: [...parentContext.permissionRules.allow],
                ask: [...parentContext.permissionRules.ask],
                deny: [...parentContext.permissionRules.deny],
            },
            permissionMode: childPermissionMode(parentContext.permissionMode),
            prePlanMode: parentContext.prePlanMode,
        };
    },
};
