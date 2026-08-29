import type {PermissionMode, PermissionRules} from "../permissions/index.js";
import type {ToolContextResources} from "../runtime/toolContext.js";
import type {CreateToolRuntimeOptions} from "../tools/runtime.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentDefinition, SubagentResult} from "./types.js";

const WORKTREE_AGENT_SAFE_TOOLS = new Set([
    "list_files",
    "glob",
    "read_file",
    "grep",
    "edit_file",
    "write_file",
    "delete_file",
    "read_tool_result",
]);

export function hasAgentWriteTools(definition: AgentDefinition): boolean {
    return definition.allowedTools.includes("edit_file") ||
        definition.allowedTools.includes("write_file") ||
        definition.allowedTools.includes("delete_file");
}

export function validateBackgroundAgent(
    definition: AgentDefinition,
    isolation?: "worktree"
): string | undefined {
    if (definition.agentType === "Explore") {
        return isolation
            ? "Explore 是只读 Agent，不需要也不接受 worktree isolation。"
            : undefined;
    }
    if (isolation !== "worktree") {
        return "后台无隔离模式只支持内置 Explore；写型自定义 Agent 必须设置 isolation=worktree。";
    }
    if (
        definition.source === "builtin" ||
        !hasAgentWriteTools(definition) ||
        !definition.allowedTools.every((tool) =>
            WORKTREE_AGENT_SAFE_TOOLS.has(tool)
        )
    ) {
        return [
            "该 Agent 不满足 Worktree 后台安全工具集合。",
            "第一版只允许 list_files/glob/read_file/grep/edit_file/write_file/delete_file/read_tool_result，且必须包含 edit_file、write_file 或 delete_file。",
        ].join("\n");
    }
    return undefined;
}

export interface SubagentRuntimeConfig {
    toolRuntimeOptions: CreateToolRuntimeOptions;
    contextResources: Omit<
        ToolContextResources,
        "model" | "provider" | "fastModel" | "fastProvider"
    >;
    permissionRules: PermissionRules;
    permissionMode: PermissionMode;
    prePlanMode?: PermissionMode;
    maxConsecutiveDeniedToolCalls?: number;
}

interface SubagentResultMetadata {
    verificationVerdict?: SubagentResult["verificationVerdict"];
}

export interface SubagentRegistration {
    definition: AgentDefinition;
    concurrencySafe: boolean;

    createRuntimeConfig(parentContext: ToolContext): SubagentRuntimeConfig;

    finalizePrompt?: string;
    parseResult?(reply: string): SubagentResultMetadata;
}
