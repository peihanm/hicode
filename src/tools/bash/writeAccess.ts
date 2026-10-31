import {realpath, stat} from "node:fs/promises";
import {resolve} from "node:path";
import type {ToolContext} from "../types.js";
import {ToolInputError} from "../types.js";
import {validateWorkspacePath} from "../../permissions/pathGuard.js";
import {isPrivateSessionPath} from "../../subagents/recordAccess.js";
import {requestApproval} from "../../permissions/approval.js";
import {commitDirectoryApproval} from "../../permissions/delegation.js";

export async function validateWriteDirectories(paths: readonly string[], ctx: ToolContext): Promise<string[]> {
    if (paths.length && ctx.readOnlyTools) throw new Error("Read-only Agents cannot request writable directories");
    const directories: string[] = [];
    for (const path of paths) {
        const absolute = await realpath(resolve(ctx.cwd, path));
        const boundary = await realpath(ctx.workspaceBoundary ?? ctx.directoryAccess.hardBoundary);
        const within = await validateWorkspacePath(boundary, ctx.cwd, absolute);
        if (!within.ok) throw new Error(within.message);
        if (ctx.permissionActor && await isPrivateSessionPath(ctx.storage, absolute)) throw new Error("Private session storage cannot be granted to a child command");
        if (!(await stat(absolute)).isDirectory()) throw new ToolInputError(`Writable directory does not exist: ${path}`);
        directories.push(await realpath(absolute));
    }
    return [...new Set(directories)];
}

/** Approval happens before spawn. A failed, partially executed command is never replayed here. */
export async function approveWriteDirectories(paths: readonly string[], input: unknown, ctx: ToolContext, toolCallId: string): Promise<string[]> {
    const epoch = ctx.approvalEpoch.signal;
    const canonical = await validateWriteDirectories(paths, ctx);
    for (const directory of canonical) {
        if (await ctx.directoryAccess.canAccess(directory) || (ctx.permissionMode === "full-access" && ctx.allowFullAccess)) continue;
        const presentation = {kind: "filesystem_access" as const, operation: "write_directory" as const,
            targetPath: directory, suggestedDirectory: directory};
        const resolution = await requestApproval(ctx, "bash", input, `Command requires write access to ${directory}`, toolCallId,
            {presentation, allowPersistent: false});
        if (resolution.decision.behavior !== "allow") throw new Error(resolution.decision.message);
        const decision = resolution.decision;
        if (Object.keys(decision).some(key => !["behavior", "directoryScope"].includes(key)) ||
            (decision.directoryScope !== undefined && !["once", "session", "project"].includes(decision.directoryScope))) {
            throw new Error("Invalid directory approval decision");
        }
        ctx.signal.throwIfAborted();
        epoch.throwIfAborted();
        await (ctx.commitDirectoryApproval ?? ((request, approved) => commitDirectoryApproval(ctx, request, approved)))(presentation, resolution);
    }
    ctx.signal.throwIfAborted();
    epoch.throwIfAborted();
    const current = await validateWriteDirectories(paths, ctx);
    if (JSON.stringify(current) !== JSON.stringify(canonical)) throw new Error("Writable directory changed during approval; command was not executed");
    return canonical;
}
