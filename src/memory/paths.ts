import {isAbsolute, join, relative, resolve} from "node:path";
import {getProjectStorageDirectory, type PillarStorageLayout} from "../persistence/index.js";
import {memoryKeySchema} from "./schema.js";

export function getMemoryDirectory(
    storage: PillarStorageLayout,
    cwd: string
): string {
    return join(getProjectStorageDirectory(storage, cwd), "memory");
}

export function getMemoryIndexPath(directory: string): string {
    return join(directory, "MEMORY.md");
}

export function getMemoryLockPath(directory: string): string {
    return join(directory, ".memory.lock");
}

export function getMemoryEntryPath(directory: string, key: string): string {
    const parsed = memoryKeySchema.parse(key);
    return join(directory, `${parsed}.md`);
}

export function classifyMemoryPath(
    directory: string,
    inputPath: string
):
    | {kind: "index"; path: string}
    | {kind: "topic"; path: string; key: string}
    | undefined {
    const root = resolve(directory);
    const path = resolve(inputPath);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
        return undefined;
    }
    if (rel === "MEMORY.md") return {kind: "index", path};
    if (!rel.endsWith(".md")) return undefined;
    const parsed = memoryKeySchema.safeParse(rel.slice(0, -3));
    return parsed.success
        ? {kind: "topic", path, key: parsed.data}
        : undefined;
}
