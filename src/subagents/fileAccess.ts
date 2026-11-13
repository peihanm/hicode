import {chmod, lstat, mkdir} from "node:fs/promises";
import {dirname, join} from "node:path";
import {readBoundedTextFile} from "../persistence/readTextFile.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";

const MAX_AGENT_DEFINITION_BYTES = 64_000;

async function ensureDirectory(path: string, create: boolean): Promise<boolean> {
    if (create) {
        try {
            await mkdir(path, {recursive: false, mode: 0o700});
        } catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
                throw error;
            }
        }
    }
    let metadata;
    try {
        metadata = await lstat(path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (!create && (code === "ENOENT" || code === "ENOTDIR")) return false;
        throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Unsafe Agent configuration directory: ${path}`);
    }
    if (create) await chmod(path, 0o700);
    return true;
}

/** Validate the managed `.hicode/agents` suffix without following symlinks. */
export async function ensureAgentDefinitionDirectory(
    directory: string,
    create = false
): Promise<boolean> {
    const hicodeDirectory = dirname(directory);
    if (create) {
        await mkdir(dirname(hicodeDirectory), {recursive: true, mode: 0o700});
    }
    const hasHiCodeDirectory = await ensureDirectory(hicodeDirectory, create);
    if (!hasHiCodeDirectory) return false;
    return ensureDirectory(directory, create);
}

export async function readAgentDefinitionFile(path: string): Promise<string> {
    return readBoundedTextFile(path, MAX_AGENT_DEFINITION_BYTES);
}

export type AgentDefinitionScope = "user" | "project";

export function getAgentDefinitionDirectory(
    storage: HiCodeStorageLayout,
    cwd: string,
    scope: AgentDefinitionScope
): string {
    return scope === "project"
        ? join(cwd, ".hicode", "agents")
        : join(storage.hicodeHome, "agents");
}
