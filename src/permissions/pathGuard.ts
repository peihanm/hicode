import {lstat, realpath} from "node:fs/promises";
import {dirname, isAbsolute, relative, resolve} from "node:path";

export function isPathInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function nearestExisting(path: string): Promise<string> {
    let current = path;
    while (true) {
        try {
            await lstat(current);
            return current;
        } catch (error) {
            if (
                !error || typeof error !== "object" || !("code" in error) ||
                (error as {code?: string}).code !== "ENOENT"
            ) throw error;
            const parent = dirname(current);
            if (parent === current) return current;
            current = parent;
        }
    }
}

export async function validateWorkspacePath(
    boundary: string,
    cwd: string,
    inputPath: string
): Promise<{ok: true; path: string} | {ok: false; message: string}> {
    const lexicalRoot = resolve(boundary);
    const target = isAbsolute(inputPath)
        ? resolve(inputPath)
        : resolve(cwd, inputPath);
    if (!isPathInside(lexicalRoot, target)) {
        return {ok: false, message: `Workspace path is out of bounds: ${inputPath}`};
    }
    try {
        const root = await realpath(lexicalRoot);
        const existing = await nearestExisting(target);
        const resolvedExisting = await realpath(existing);
        if (!isPathInside(root, resolvedExisting)) {
            return {ok: false, message: `Workspace path escapes through a symlink: ${inputPath}`};
        }
    } catch (error) {
        return {
            ok: false,
            message: `Cannot validate workspace path ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    return {ok: true, path: target};
}

export function toolPathInput(
    toolName: string,
    input: unknown
): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    const value = input as Record<string, unknown>;
    if (
        toolName === "read_file" ||
        toolName === "view_image" ||
        toolName === "edit_file" ||
        toolName === "write_file"
    ) {
        return typeof value.path === "string" ? value.path : undefined;
    }
    return undefined;
}
