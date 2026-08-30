// 权限解析主逻辑
// 参考 claude-code src/utils/permissions/permissions.ts:hasPermissionsToUseToolInner
//
// 优先级链：
//   1. deny 规则匹配
//   2. tool.checkPermissions 的 deny
//   3. ask 规则匹配
//   4. 必须用户交互的 tool ask
//   5. PermissionMode 顶层开关
//   6. acceptEdits 模式 + cwd 内文件编辑工具
//   7. allow 规则匹配
//   8. tool.checkPermissions 的 allow/ask
//   9. 默认规则（isReadOnly → allow，写操作 → ask）
//   10. dontAsk 把 ask 转 deny

import type {PermissionMatcher, PermissionRuleBehavior, Tool, ToolContext} from "../tools/types.js";
import type {PermissionResult} from "./types.js";
import {matchPattern} from "./matchPattern.js";
import {toolPathInput, validateWorkspacePath} from "../worktrees/pathGuard.js";
import {parsePermissionRule} from "./rules.js";

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
    if (ctx.permissionMode === "dontAsk" && result.behavior === "ask") {
        return {
            behavior: "deny",
            message: "dontAsk 模式下需要确认的操作被拒绝",
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

    // 1. deny 规则（最高优先级）
    for (const rule of rules.deny) {
        if (ruleMatches(rule, tool.name, matcher, "deny")) {
            return {
                behavior: "deny",
                message: `被 deny 规则拒绝: ${rule.toolName}(${rule.content ?? "*"})`,
            };
        }
    }

    // 2. 工具自己的 deny 永远优先，例如 edit_file 的 stale/read 校验。
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
    if (tool.requiresUserInteraction?.(input) && toolResult.behavior === "ask") {
        return toolResult;
    }

    // 5. bypassPermissions：跳过普通确认，但不绕过 deny/ask/user interaction。
    if (mode === "bypassPermissions") {
        return {behavior: "allow"};
    }

    // 6. plan：只读自动放行，写操作需要确认而不是硬拒绝。
    if (mode === "plan") {
        const isReadOnly = tool.isReadOnly?.(input) ?? false;
        if (isReadOnly) return {behavior: "allow"};
        return toolResult.behavior === "ask"
            ? toolResult
            : {behavior: "ask", message: `plan 模式下工具 ${tool.name} 需要确认`};
    }

    // 7. acceptEdits：仅 cwd 内文件编辑自动放行，且不绕过上面的 deny/ask。
    if (mode === "acceptEdits" && isFileEditTool(tool)) {
        const path = toolPathInput(tool.name, input);
        if (path !== undefined) {
            const scoped = await validateWorkspacePath(ctx.cwd, ctx.cwd, path);
            if (scoped.ok) return {behavior: "allow"};
        }
    }

    // 8. allow 规则
    for (const rule of rules.allow) {
        if (ruleMatches(rule, tool.name, matcher, "allow")) {
            return {behavior: "allow"};
        }
    }

    // 9. 工具自己的 allow/ask
    if (toolResult.behavior !== "passthrough") {
        return toolResult;
    }

    // 10. default fallback：只读放行，写操作 ask
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

// 判断是否文件编辑工具（用于 acceptEdits 模式）
function isFileEditTool(tool: Tool): boolean {
    return tool.name === "write_file" ||
        tool.name === "edit_file" ||
        tool.name === "delete_file";
}
