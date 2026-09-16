import {constants} from "node:fs";
import {chmod, lstat, mkdir, open} from "node:fs/promises";
import {dirname} from "node:path";

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
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
            throw new Error("Agent definition must be a regular file");
        }
        if (metadata.size > MAX_AGENT_DEFINITION_BYTES) {
            throw new Error(`File exceeds the ${MAX_AGENT_DEFINITION_BYTES} byte limit`);
        }
        const buffer = Buffer.alloc(MAX_AGENT_DEFINITION_BYTES + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
            const {bytesRead} = await handle.read(
                buffer,
                offset,
                buffer.byteLength - offset,
                offset
            );
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > MAX_AGENT_DEFINITION_BYTES) {
            throw new Error(`File exceeds the ${MAX_AGENT_DEFINITION_BYTES} byte limit`);
        }
        return new TextDecoder("utf-8", {fatal: true}).decode(buffer.subarray(0, offset));
    } finally {
        await handle.close();
    }
}
