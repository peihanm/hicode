import type {PermissionMode, PermissionPromptPolicy, PermissionRules} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {ToolContextResources} from "../runtime/toolContext.js";
import type {CreateToolRuntimeOptions} from "../tools/runtime.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentDefinition} from "./types.js";

const WORKTREE_AGENT_SAFE_TOOLS = new Set([
    "list_files",
    "glob",
    "read_file",
    "grep",
    "edit_file",
    "write_file",
    "delete_file",
]);

export function hasAgentWriteTools(definition: AgentDefinition): boolean {
    // A name alone cannot prove Bash or dynamic MCP arguments are read-only.
    return definition.allowedTools.some(name => ![
        "list_files", "glob", "read_file", "grep", "web_fetch",
    ].includes(name));
}

export function supportsWorkspaceWriteGrant(definition: AgentDefinition): boolean {
    return hasAgentWriteTools(definition) &&
        definition.allowedTools.every(name => WORKTREE_AGENT_SAFE_TOOLS.has(name));
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
            "第一版只允许 list_files/glob/read_file/grep/edit_file/write_file/delete_file，且必须包含 edit_file、write_file 或 delete_file。",
        ].join("\n");
    }
    return undefined;
}

export interface SubagentRuntimeConfig {
    toolRuntimeOptions: CreateToolRuntimeOptions;
    contextResources: Omit<
        ToolContextResources,
        "model" | "provider" | "fastModel" | "fastProvider" | "fileCommits"
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
