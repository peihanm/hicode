import { basename, dirname, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { HiCodeStorageLayout } from "../persistence/layout.js";
import { memoryKeySchema } from "./schema.js";
import {parseMemoryTopic} from "./topic.js";
import type { MemoryPublicationStore } from "./publicationStore.js";
import type { MemoryChange } from "./types.js";
export type PublicationPath = {
    kind: "index";
    path: string;
} | {
    kind: "topic";
    key: string;
    path: string;
};
export interface PublicationFileAccess {
    readonly directory: string;
    classify(path: string): PublicationPath | undefined;
    prepare(path: string, toolName: string): Promise<void>;
    validateWrite(path: string, content: string): void;
    written(path: string, content: string, created: boolean): MemoryChange;
    shellDirectory(path: string): Promise<string | undefined>;
}
export function classifyPublicationPath(directory: string, inputPath: string): PublicationPath | undefined {
    const path = resolve(inputPath);
    const rel = relative(resolve(directory), path);
    if (rel === "MEMORY.md")
        return { kind: "index", path };
    const match = /^(topics)\/([^/]+)\.md$/.exec(rel);
    const key = memoryKeySchema.safeParse(match?.[2]);
    return match && key.success ? { kind: "topic", key: key.data, path } : undefined;
}
export function isMemoryStoragePath(storage: HiCodeStorageLayout, path: string): boolean {
    const rel = relative(storage.projectsRoot, resolve(path));
    return !rel.startsWith("..") && /^[^/]+\/memory(?:\/|$)/.test(rel);
}
export async function checkMemoryStoragePath(storage: HiCodeStorageLayout, path: string): Promise<boolean> {
    if (isMemoryStoragePath(storage, path))
        return true;
    let probe = resolve(path);
    const missing: string[] = [];
    for (;;) {
        try {
            const canonical = resolve(await realpath(probe), ...missing);
            if (!/\/memory(?:\/|$)/.test(canonical))
                return false;
            const root = await realpath(storage.projectsRoot).catch(error => {
                if (error?.code === "ENOENT")
                    return null;
                throw error;
            });
            if (root === null)
                return false;
            const rel = relative(root, canonical);
            if (!rel.startsWith("..") && /^[^/]+\/memory(?:\/|$)/.test(rel))
                throw new Error("Memory cannot be accessed through path aliases; use the framework-provided path");
            return false;
        }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
                throw error;
            const parent = dirname(probe);
            if (parent === probe || missing.length >= 256)
                throw new Error("Cannot validate Memory path");
            missing.unshift(basename(probe));
            probe = parent;
        }
    }
}
export function createPublicationFileAccess(store: MemoryPublicationStore): PublicationFileAccess {
    const requirePath = (path: string) => {
        const managed = classifyPublicationPath(store.directory, path);
        if (!managed)
            throw new Error("Memory path is not a public topic or index in the current project");
        return managed;
    };
    return {
        directory: store.directory,
        classify: path => classifyPublicationPath(store.directory, path),
        async prepare(path, toolName) {
            const managed = requirePath(path);
            const reading = toolName === "read_file";
            const writing = managed.kind === "topic" && (toolName === "write_file" || toolName === "edit_file");
            if (!reading && !writing) throw new Error("Only Memory topics can be edited; the index is generated from files");
            if (writing) store.prepareTopicsDirectory();
            else if (!await store.prepareView(managed)) throw new Error("Memory file does not exist");
        },
        validateWrite(path, content) {
            const managed = requirePath(path);
            if (managed.kind !== "topic") throw new Error("The Memory index is generated from topic files");
            parseMemoryTopic(content, managed.key);
        },
        written(path, content, created) {
            const managed = requirePath(path);
            if (managed.kind !== "topic") throw new Error("Only Memory topics can be written");
            return {action: created ? "created" : "updated", key: managed.key, memoryType: parseMemoryTopic(content, managed.key).type};
        },
        async shellDirectory(path) {
            if (resolve(path) !== resolve(store.directory, "topics")) return undefined;
            return store.prepareTopicsDirectory();
        },
    };
}
