// 权限解析主逻辑
// 参考 claude-code src/utils/permissions/permissions.ts:hasPermissionsToUseToolInner
//
// 优先级链：
//   1. deny 规则匹配
//   2. tool.checkPermissions 的 deny
//   3. ask 规则匹配
//   4. 必须用户交互的 tool ask
//   5. Plan collaboration mode 收窄写操作
//   6. Bypass / Read Only permission profile
//   7. Default + 可验证的 workspace/sandboxed 副作用范围
//   8. allow 规则匹配
//   9. tool.checkPermissions 的 allow/ask
//   10. 默认规则（isReadOnly → allow，写操作 → ask）
//   11. 非交互 Host 把 ask 转 deny

import type {PermissionMatcher, PermissionRuleBehavior, Tool, ToolContext} from "../tools/types.js";
import type {PermissionResult} from "./types.js";
import {matchPattern} from "./matchPattern.js";
import {toolPathInput, validateWorkspacePath} from "../worktrees/pathGuard.js";
import {parsePermissionRule} from "./rules.js";
import {directoryOperationForTool} from "./directoryAccess.js";

/**
 * 用当前工具的真实权限 matcher 判断单条规则。Hook `if` 复用该
 * 语义，但匹配结果只负责过滤 Hook，不会改变权限裁决。
 */
export async function matchesToolPermissionRule(
    tool: Tool,
    input: unknown,
    ruleText: string
): Promise<boolean> {
    const parsedInput = tool.parameters.safeParse(input);
    if (!parsedInput.success) return false;
    const rule = parsePermissionRule(ruleText);
    const matcher = await getMatcher(tool, parsedInput.data);
    return ruleMatches(rule, tool.name, matcher, "allow");
}

export async function resolvePermission(
    tool: Tool,
    input: unknown,
    ctx: ToolContext
): Promise<PermissionResult> {
    const result = await resolvePermissionInner(tool, input, ctx);
    if (ctx.permissionPromptPolicy === "never" && result.behavior === "ask") {
        return {
            behavior: "deny",
            message: "当前 Host 不支持权限交互，需要确认的操作被拒绝",
        };
    }
    return result;
}

async function resolvePermissionInner(
    tool: Tool,
    input: unknown,
    ctx: ToolContext
): Promise<PermissionResult> {
    const mode = ctx.permissionMode;

    if (ctx.workspaceBoundary) {
        const path = toolPathInput(tool.name, input);
        if (path !== undefined) {
            const scoped = await validateWorkspacePath(
                ctx.workspaceBoundary,
                ctx.cwd,
                path
            );
            if (!scoped.ok) {
                return {behavior: "deny", message: scoped.message};
            }
        }
    }

    const matcher = await getMatcher(tool, input);
    const rules = ctx.permissionRules;
    const defaultScope = tool.getDefaultApprovalScope?.(input, ctx);

    // 1. deny 规则（最高优先级）
    for (const rule of rules.deny) {
        if (ruleMatches(rule, tool.name, matcher, "deny")) {
            return {
                behavior: "deny",
                message: `被 deny 规则拒绝: ${rule.toolName}(${rule.content ?? "*"})`,
            };
        }
    }

    // 2. 工具自己的 deny 永远优先。
    const toolResult: PermissionResult = tool.checkPermissions
        ? await tool.checkPermissions(input, ctx)
        : {behavior: "passthrough"};
    if (toolResult.behavior === "deny") {
        return toolResult;
    }

    // 3. ask 规则：用户显式要求确认时，高权限 mode 也不绕过。
    for (const rule of rules.ask) {
        if (ruleMatches(rule, tool.name, matcher, "ask")) {
            return {
                behavior: "ask",
                message: `规则要求确认: ${rule.toolName}(${rule.content ?? "*"})`,
            };
        }
    }

    // 4. 必须用户交互的工具即使在 bypassPermissions 下也要问。
    if (tool.requiresUserInteraction?.(input, ctx) && toolResult.behavior === "ask") {
        return toolResult;
    }

    // 5. Plan 是独立工作模式，在 Permission Profile 前收窄写操作。
    if (ctx.collaborationMode === "plan") {
        const isReadOnly = tool.isReadOnly?.(input) ?? false;
        if (isReadOnly) return {behavior: "allow"};
        return toolResult.behavior === "ask"
            ? toolResult
            : {behavior: "ask", message: `Plan 模式下工具 ${tool.name} 需要确认`};
    }

    // 6. Bypass 跳过普通确认；Read Only 只自动允许只读调用。
    if (mode === "bypassPermissions") {
        return {behavior: "allow"};
    }
    if (mode === "readOnly") {
        const isReadOnly = tool.isReadOnly?.(input) ?? false;
        if (isReadOnly) return {behavior: "allow"};
        return toolResult.behavior === "ask"
            ? toolResult
            : {behavior: "ask", message: `Read Only 模式下工具 ${tool.name} 需要确认`};
    }

    let workspaceAccess: boolean | undefined;
    if (defaultScope?.kind === "workspace") {
        try {
            workspaceAccess = await ctx.directoryAccess.canAccess(defaultScope.path);
        } catch (error) {
            return {
                behavior: "deny",
                message: `无法安全验证目录访问: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    // 8. Default：只自动批准可验证的 workspace 或 OS Sandbox 副作用。
    // 显式 ask、Tool deny、强制交互与 Plan 已在更高优先级处理。
    if (mode === "default") {
        if (defaultScope?.kind === "sandboxed") return {behavior: "allow"};
        if (defaultScope?.kind === "workspace" && workspaceAccess) {
            return {behavior: "allow"};
        }
    }

    // 9. allow 规则
    for (const rule of rules.allow) {
        if (ruleMatches(rule, tool.name, matcher, "allow")) {
            // Tool allow 只控制调用确认，不能隐式扩大文件系统范围。
            if (defaultScope?.kind === "workspace" && !workspaceAccess) {
                continue;
            }
            return {behavior: "allow"};
        }
    }

    // 10. 工具自己的 allow/ask
    if (toolResult.behavior !== "passthrough") {
        if (
            toolResult.behavior === "ask" &&
            defaultScope?.kind === "workspace" &&
            workspaceAccess === false
        ) {
            const operation = directoryOperationForTool(tool.name);
            if (operation) {
                let request;
                try {
                    request = await ctx.directoryAccess.createRequest(
                        defaultScope.path,
                        operation
                    );
                } catch (error) {
                    return {
                        behavior: "deny",
                        message: `无法安全创建目录授权: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
                return {
                    ...toolResult,
                    allowPersistent: false,
                    presentation: {kind: "filesystem_access", ...request},
                };
            }
        }
        return toolResult;
    }

    // 11. default fallback：只读放行，写操作 ask
    const isReadOnly = tool.isReadOnly?.(input) ?? false;
    return isReadOnly
        ? {behavior: "allow"}
        : {behavior: "ask", message: `工具 ${tool.name} 需要确认`};
}

// 规则匹配：工具名必须相等 + 内容匹配（如果有 content）
function ruleMatches(
    rule: { toolName: string; content?: string },
    toolName: string,
    matcher: PermissionMatcher,
    behavior: PermissionRuleBehavior
): boolean {
    if (rule.toolName !== toolName) return false;
    if (rule.content === undefined) return true; // 整工具匹配
    return matcher(rule.content, behavior); // 内容匹配
}

// 获取 matcher：工具自定义优先，否则用默认（JSON.stringify + matchPattern）
async function getMatcher(
    tool: Tool,
    input: unknown
): Promise<PermissionMatcher> {
    if (tool.preparePermissionMatcher) {
        return tool.preparePermissionMatcher(input);
    }
    // 默认：input 字符串化后跟 pattern 匹配
    const inputStr =
        typeof input === "string" ? input : JSON.stringify(input);
    return (pattern: string) => matchPattern(pattern, inputStr);
}
