import {realpath, stat} from "node:fs/promises";
import {isAbsolute, resolve} from "node:path";
import {isPathInside} from "../permissions/pathGuard.js";
import type {PermissionRules} from "../permissions/types.js";
import {createProjectInstructionLoader, type ProjectInstructions} from "../prompt/instructions.js";
import type {ToolContext} from "../tools/types.js";

/** cwd selects an existing granted directory; it never creates a new grant. */
export async function resolveSubagentDirectory(parent: ToolContext, path = parent.cwd): Promise<string> {
    const target = resolve(parent.cwd, path);
    if (!await parent.directoryAccess.canAccess(target)) throw new Error(`子 Agent cwd 不在父任务已授权目录内: ${path}`);
    const canonical = await realpath(target);
    if (!await parent.directoryAccess.canAccess(canonical)) throw new Error(`子 Agent cwd 在校验期间越过已授权目录: ${path}`);
    if (!(await stat(canonical)).isDirectory()) throw new Error(`子 Agent cwd 不是目录: ${path}`);
    if (parent.workspaceBoundary && !isPathInside(await realpath(parent.workspaceBoundary), canonical)) {
        throw new Error(`子 Agent cwd 越过父工作区边界: ${path}`);
    }
    return canonical;
}

/** File rules retain their original project-relative meaning after switching cwd. */
export function subagentPermissionRules(parent: ToolContext): PermissionRules {
    const pathTools = new Set(["list_files", "glob", "read_file", "grep", "edit_file", "write_file", "delete_file", "view_image"]);
    const anchor = (rules: PermissionRules["allow"]) => rules.map(rule => ({...rule,
        ...(pathTools.has(rule.toolName) && rule.content !== undefined && !isAbsolute(rule.content)
            ? {content: resolve(parent.cwd, rule.content)} : {}),
    }));
    return {allow: anchor(parent.permissionRules.allow), ask: anchor(parent.permissionRules.ask), deny: anchor(parent.permissionRules.deny)};
}

export async function subagentInstructions(parent: ToolContext, cwd: string): Promise<ProjectInstructions> {
    if (cwd === await realpath(parent.cwd)) return parent.instructions;
    const parentCwd = await realpath(parent.cwd);
    const inherited = parent.instructions.files.filter(file =>
        file.scope === "host" || file.scope === "user" || isPathInside(parentCwd, cwd));
    const boundary = parent.directoryAccess.listDirectories().filter(directory => isPathInside(directory, cwd))
        .sort((a, b) => b.length - a.length)[0] ?? cwd;

    const loaded = await createProjectInstructionLoader({sources: ["project", "local"],
        maxTotalChars: Math.max(0, 120_000 - inherited.reduce((total, file) => total + file.content.length, 0)),
    })(cwd, boundary);
    const loadedPaths = new Set(loaded.files.flatMap(file => file.scope === "host" ? [] : [file.path]));
    return {files: [...inherited.filter(file => file.scope === "host" || !loadedPaths.has(file.path)), ...loaded.files],
        issues: [...parent.instructions.issues, ...loaded.issues]};
}
