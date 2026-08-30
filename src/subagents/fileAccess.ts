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
        throw new Error(`Agent 配置目录不安全: ${path}`);
    }
    if (create) await chmod(path, 0o700);
    return true;
}

/** Validate the managed `.pillar/agents` suffix without following symlinks. */
export async function ensureAgentDefinitionDirectory(
    directory: string,
    create = false
): Promise<boolean> {
    const pillarDirectory = dirname(directory);
    if (create) {
        await mkdir(dirname(pillarDirectory), {recursive: true, mode: 0o700});
    }
    const hasPillarDirectory = await ensureDirectory(pillarDirectory, create);
    if (!hasPillarDirectory) return false;
    return ensureDirectory(directory, create);
}

export async function readAgentDefinitionFile(path: string): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
            throw new Error("Agent 定义必须是普通文件");
        }
        if (metadata.size > MAX_AGENT_DEFINITION_BYTES) {
            throw new Error(`文件超过 ${MAX_AGENT_DEFINITION_BYTES} bytes 上限`);
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
            throw new Error(`文件超过 ${MAX_AGENT_DEFINITION_BYTES} bytes 上限`);
        }
        return new TextDecoder("utf-8", {fatal: true}).decode(buffer.subarray(0, offset));
    } finally {
        await handle.close();
    }
}
