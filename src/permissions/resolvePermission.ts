// 路径/Host 边界 → deny → Tool 自检 → 只读/Plan 能力约束 → 用户问题。
// Full Access 预授权普通访问；其余请求依次应用 ask、显式审批、工作区范围、allow 和默认意向。
// 人审可用性和自动审核统一由 requestApproval 处理，解析阶段不替 Host 作决定。

import type {PermissionMatcher, PermissionRuleBehavior, Tool, ToolContext} from "../tools/types.js";
import type {PermissionResult} from "./types.js";
import {matchPattern} from "./matchPattern.js";
import {toolPathInput, validateWorkspacePath} from "./pathGuard.js";
import {parsePermissionRule} from "./rules.js";
import {directoryOperationForTool} from "./directoryAccess.js";
import {resolveToolPath} from "../tools/shared/paths.js";
import {checkSessionArchivePath, resolveSessionArchiveFile} from "../session/archiveAccess.js";
import {checkMemoryStoragePath} from "../memory/publicationAccess.js";
import {createFilePermissionMatcher} from "./filePattern.js";

/**
 * 用当前工具的真实权限 matcher 判断单条规则。Hook `if` 复用该
 * 语义，但匹配结果只负责过滤 Hook，不会改变权限裁决。
 */
export async function matchesToolPermissionRule(
    tool: Tool,
    input: unknown,
    ruleText: string,
    cwd: string
): Promise<boolean> {
    const parsedInput = tool.parameters.safeParse(input);
    if (!parsedInput.success) return false;
    const rule = parsePermissionRule(ruleText);
    if (rule.toolName !== tool.name) return false;
    const matcher = await getMatcher(tool, parsedInput.data, cwd, rule.content === undefined ? [] : [rule.content]);
    return ruleMatches(rule, tool.name, matcher, toolPathInput(tool.name, parsedInput.data) === undefined ? "allow" : "deny");
}

export async function resolvePermission(
    tool: Tool,
    input: unknown,
    ctx: ToolContext
): Promise<PermissionResult> {
    return resolvePermissionInner(tool, input, ctx);
}

async function resolvePermissionInner(
    tool: Tool,
    input: unknown,
    ctx: ToolContext
): Promise<PermissionResult> {
    const mode = ctx.permissionMode;
    if (ctx.approvalBudget.stopped) return {behavior: "deny", message: ctx.approvalBudget.stopMessage};
    if (mode === "full-access" && !ctx.allowFullAccess) {
        return {behavior: "deny", message: "当前 Host 不允许 Full Access"};
    }
    let archiveRead = false;
    let memoryAccess = false;
    const archiveInputPath = toolPathInput(tool.name, input);
    if (archiveInputPath !== undefined) {
        const path = resolveToolPath(ctx.cwd, archiveInputPath);
        try {
            if (await checkMemoryStoragePath(ctx.storage, path)) {
                if (!ctx.memoryFiles) return {behavior: "deny", message: "当前 Agent 没有 Memory 文件能力"};
                await ctx.memoryFiles.prepare(path, tool.name);
                memoryAccess = true;
            }
        } catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
        let managed: boolean;
        try {managed = await checkSessionArchivePath(ctx.storage, path);}
        catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
        if (managed) {
            if (tool.name !== "read_file" && tool.name !== "grep") return {behavior: "deny", message: "Session 压缩档案仅允许精确 read_file/grep 读取"};
            try {archiveRead = !!await resolveSessionArchiveFile(ctx.storage, ctx.sessionArchives, path);}
            catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
        }
    }

    if (ctx.workspaceBoundary) {
        const path = toolPathInput(tool.name, input);
        if (path !== undefined) {
            let savedOutput = false;
            if (tool.name === "read_file" || tool.name === "grep") {
                try {
                    savedOutput = (await ctx.toolResultFiles.resolveFile(resolveToolPath(ctx.cwd, path))) !== null;
                } catch (error) {
                    return {behavior: "deny", message: `无法验证结果文件: ${error instanceof Error ? error.message : String(error)}`};
                }
            }
            const scoped = await validateWorkspacePath(
                ctx.workspaceBoundary,
                ctx.cwd,
                path
            );
            if (!scoped.ok && !savedOutput && !archiveRead && !memoryAccess) {
                return {behavior: "deny", message: scoped.message};
            }
        }
    }

    const rules = ctx.permissionRules;
    const patterns = [...rules.allow, ...rules.ask, ...rules.deny].filter(rule => rule.toolName === tool.name)
        .flatMap(rule => rule.content === undefined ? [] : [rule.content]);
    const matcher = await getMatcher(tool, input, ctx.cwd, patterns);
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
    if (ctx.readOnlyTools && !(tool.isReadOnly?.(input) ?? false)) {
        return {behavior: "deny", message: "当前 Agent 仅允许只读工具调用"};
    }

    // Plan 由 Host 控制；显式副作用不能通过单次审批开始实施。
    // Bash 的工作目的由模式指令约束，实际访问仍走下面的权限链。
    if (ctx.collaborationMode === "plan" && tool.name !== "bash" &&
        !(tool.isReadOnly?.(input) ?? false) && tool.name !== "ask_user" && tool.name !== "todo_write") {
        return {behavior: "deny", message: `Plan 模式不执行 ${tool.name} 的修改操作；请由用户切换 Build 后再实施`};
    }

    // 用户问题属于交互，不由访问预授权替代。
    if (tool.name === "ask_user") return toolResult;
    if (mode === "full-access") return {behavior: "allow"};

    // 3. 显式 ask 仍送往当前审核者。
    for (const rule of rules.ask) {
        if (ruleMatches(rule, tool.name, matcher, "ask")) {
            return {
                behavior: "ask",
                message: `规则要求确认: ${rule.toolName}(${rule.content ?? "*"})`,
            };
        }
    }

    // 普通 allow 规则不能替代本次明确的额外访问审批。
    if (tool.requiresExplicitApproval?.(input, ctx) && toolResult.behavior === "ask") {
        return toolResult;
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
    if (mode === "ask" || mode === "auto-review") {
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

// File paths have one shared policy; other tools can specialize their argument matcher.
async function getMatcher(
    tool: Tool,
    input: unknown,
    cwd: string,
    patterns: readonly string[]
): Promise<PermissionMatcher> {
    const path = toolPathInput(tool.name, input);
    if (path !== undefined) return createFilePermissionMatcher(cwd, path, patterns);
    if (tool.preparePermissionMatcher) {
        return tool.preparePermissionMatcher(input);
    }
    // 默认：input 字符串化后跟 pattern 匹配
    const inputStr =
        typeof input === "string" ? input : JSON.stringify(input);
    return (pattern: string) => matchPattern(pattern, inputStr);
}
