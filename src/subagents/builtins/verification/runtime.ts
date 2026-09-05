import type {Tool, ToolContext} from "../../../tools/types.js";
import type {SubagentRuntimeConfig} from "../../registration.js";
import {VERIFICATION_AGENT} from "./definition.js";
import {createVerificationBashTool, verificationBashTaskTool,} from "./tools.js";

const VERIFICATION_BROWSER_MCP_PATTERN =
    /^mcp__(?:playwright|browser|browser_use|chrome|chrome_devtools|claude_in_chrome)__/i;

function canUseMcpTool(tool: Tool): boolean {
    if (VERIFICATION_BROWSER_MCP_PATTERN.test(tool.name)) return true;
    try {
        // MCP adapter 的 isReadOnly 只反映 Server annotations；未显式标注时
        // 默认不继承，不把普通外部 capability 当成可信的只读工具。
        return tool.isReadOnly?.({}) === true;
    } catch {
        return false;
    }
}

export function createVerificationRuntimeConfig(
    parentContext: ToolContext
): SubagentRuntimeConfig {
    // Verification 已经把 MCP 能力收窄到浏览器或显式只读工具；再次要求它
    // 搜索这些少量工具只会浪费一次迭代，因此在该隔离 Runtime 中直接暴露。
    const mcpTools = (parentContext.mcpManager?.getTools() ?? [])
        .filter(canUseMcpTool)
        .map((tool) => ({...tool, exposure: "direct" as const}));
    return {
        toolRuntimeOptions: {
            allowedToolNames: [
                ...VERIFICATION_AGENT.allowedTools,
                ...mcpTools.map((tool) => tool.name),
            ],
            additionalTools: mcpTools,
            toolOverrides: [
                createVerificationBashTool(),
                verificationBashTaskTool,
            ],
        },
        contextResources: {
            storage: parentContext.storage,
            cwd: parentContext.cwd,
            workspaceBoundary:
                parentContext.workspaceBoundary ?? parentContext.cwd,
            skills: [],
            instructions: parentContext.instructions,
            shellRunner: parentContext.shellRunner,
            ...(parentContext.tasks
                ? {tasks: parentContext.tasks}
                : {}),
        },
        permissionRules: {
            allow: [
                ...parentContext.permissionRules.allow,
                ...mcpTools
                    .filter((tool) =>
                        VERIFICATION_BROWSER_MCP_PATTERN.test(tool.name)
                    )
                    .map((tool) => ({
                        toolName: tool.name,
                        source: "local" as const,
                    })),
            ],
            ask: [...parentContext.permissionRules.ask],
            deny: [...parentContext.permissionRules.deny],
        },
        permissionMode: "readOnly",
        collaborationMode: parentContext.collaborationMode,
        permissionPromptPolicy: "never",
        maxConsecutiveDeniedToolCalls: 3,
    };
}
