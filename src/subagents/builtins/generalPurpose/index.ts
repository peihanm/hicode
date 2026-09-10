import type {SubagentRegistration} from "../../registration.js";
import {GENERAL_PURPOSE_PROMPT} from "./prompt.js";
import type {AgentDefinition} from "../../types.js";

const GENERAL_PURPOSE_AGENT: AgentDefinition = {
    agentType: "GeneralPurpose",
    source: "builtin",
    whenToUse:
        "默认不自动使用。只有用户明确要求委派，或边界清楚的独立实现确实需要 fresh context 隔离时才使用。它是前台串行 Agent，不用于承接整个已批准计划，也不能声称与 Root 并行；普通顺序实现由 Root 直接完成。",
    allowedTools: [
        "list_files",
        "glob",
        "read_file",
        "grep",
        "edit_file",
        "write_file",
        "delete_file",
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
                gitSession: parentContext.gitSession,
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
