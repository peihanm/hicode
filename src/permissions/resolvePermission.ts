// Path/Host boundary -> deny -> tool checks -> read-only/Plan limits -> user questions.
// Full Access preauthorizes ordinary access; other requests apply ask, explicit approval, workspace scope, allow and default intent.
// requestApproval owns human availability and auto-review; resolution does not decide on behalf of the Host.

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

/** Match a rule using the tool's real permission matcher. Hook if shares matching semantics but only filters Hook execution; it never changes permission decisions. */
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
        return {behavior: "deny", message: "This Host does not allow Full Access"};
    }
    let archiveRead = false;
    let memoryAccess = false;
    const archiveInputPath = toolPathInput(tool.name, input);
    if (archiveInputPath !== undefined) {
        const path = resolveToolPath(ctx.cwd, archiveInputPath);
        try {
            if (await checkMemoryStoragePath(ctx.storage, path)) {
                if (!ctx.memoryFiles) return {behavior: "deny", message: "This Agent has no Memory file capability"};
                await ctx.memoryFiles.prepare(path, tool.name);
                memoryAccess = true;
            }
        } catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
        let managed: boolean;
        try {managed = await checkSessionArchivePath(ctx.storage, path);}
        catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
        if (managed) {
            if (tool.name !== "read_file" && tool.name !== "grep") return {behavior: "deny", message: "Session compaction archives may only be read by exact read_file/grep requests"};
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
                    return {behavior: "deny", message: `Cannot validate result file: ${error instanceof Error ? error.message : String(error)}`};
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

    // 1. Explicit deny rules have highest priority.
    for (const rule of rules.deny) {
        if (ruleMatches(rule, tool.name, matcher, "deny")) {
            return {
                behavior: "deny",
                message: `Denied by rule: ${rule.toolName}(${rule.content ?? "*"})`,
            };
        }
    }

    // 2. A tool's own deny always takes precedence.
    const toolResult: PermissionResult = tool.checkPermissions
        ? await tool.checkPermissions(input, ctx)
        : {behavior: "passthrough"};
    if (toolResult.behavior === "deny") {
        return toolResult;
    }
    if (ctx.readOnlyTools && !(tool.isReadOnly?.(input) ?? false)) {
        return {behavior: "deny", message: "This Agent only allows read-only tool calls"};
    }

    // Host controls Plan; one-time approval cannot enable explicit implementation side effects.
    // Mode instructions constrain Bash intent; actual access still follows the permission chain below.
    if (ctx.collaborationMode === "plan" && tool.name !== "bash" &&
        !(tool.isReadOnly?.(input) ?? false) && tool.name !== "ask_user" && tool.name !== "todo_write") {
        return {behavior: "deny", message: `Plan mode does not execute modifying operations for ${tool.name} ; the user must switch to Build before implementation`};
    }

    // User questions require interaction, not access preauthorization.
    if (tool.name === "ask_user") return toolResult;
    if (mode === "full-access") return {behavior: "allow"};

    // 3. Explicit ask still goes to the current reviewer.
    for (const rule of rules.ask) {
        if (ruleMatches(rule, tool.name, matcher, "ask")) {
            return {
                behavior: "ask",
                message: `Rule requires approval: ${rule.toolName}(${rule.content ?? "*"})`,
            };
        }
    }

    // Ordinary allow rules cannot replace explicit approval of this extra access.
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
                message: `Cannot safely validate directory access: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    // 8. Default approves only provable workspace or OS Sandbox side effects.
    // Explicit ask, tool deny, required interaction and Plan were handled at higher priority.
    if (mode === "ask" || mode === "auto-review") {
        if (defaultScope?.kind === "sandboxed") return {behavior: "allow"};
        if (defaultScope?.kind === "workspace" && workspaceAccess) {
            return {behavior: "allow"};
        }
    }

    // 9. Allow rules.
    for (const rule of rules.allow) {
        if (ruleMatches(rule, tool.name, matcher, "allow")) {
            // Tool allow controls call confirmation only; it cannot widen filesystem access implicitly.
            if (defaultScope?.kind === "workspace" && !workspaceAccess) {
                continue;
            }
            return {behavior: "allow"};
        }
    }

    // 10. The tool's own allow/ask intent.
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
                        message: `Cannot safely create a directory grant: ${error instanceof Error ? error.message : String(error)}`,
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

    // 11. Default fallback: allow reads, ask for writes.
    const isReadOnly = tool.isReadOnly?.(input) ?? false;
    return isReadOnly
        ? {behavior: "allow"}
        : {behavior: "ask", message: `Tool ${tool.name} requires approval`};
}

// Rule matching requires the same tool name and, when provided, matching content.
function ruleMatches(
    rule: { toolName: string; content?: string },
    toolName: string,
    matcher: PermissionMatcher,
    behavior: PermissionRuleBehavior
): boolean {
    if (rule.toolName !== toolName) return false;
    if (rule.content === undefined) return true; // Match the whole tool.
    return matcher(rule.content, behavior); // Match content.
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
    // Default: stringify input and match against the pattern.
    const inputStr =
        typeof input === "string" ? input : JSON.stringify(input);
    return (pattern: string) => matchPattern(pattern, inputStr);
}
