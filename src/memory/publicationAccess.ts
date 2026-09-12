import { basename, dirname, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { PillarStorageLayout } from "../persistence/layout.js";
import { memoryKeySchema } from "./schema.js";
import { parseMemoryNote } from "./note.js";
import type { MemoryPublicationStore } from "./publicationStore.js";
import type { MemoryChange } from "./types.js";
export type PublicationPath = {
    kind: "index";
    path: string;
} | {
    kind: "topic" | "note";
    key: string;
    path: string;
};
export interface PublicationFileAccess {
    readonly directory: string;
    classify(path: string): PublicationPath | undefined;
    prepare(path: string, toolName: string): Promise<void>;
    validateWrite(path: string, content: string): void;
    write(path: string, content: string, expectedContent: string | null, toolCallId: string): Promise<MemoryChange>;
    delete(path: string, expectedContent: string): Promise<MemoryChange | undefined>;
}
export function classifyPublicationPath(directory: string, inputPath: string): PublicationPath | undefined {
    const path = resolve(inputPath);
    const rel = relative(resolve(directory), path);
    if (rel === "views/MEMORY.md")
        return { kind: "index", path };
    const match = /^(views|inbox)\/([^/]+)\.md$/.exec(rel);
    const key = memoryKeySchema.safeParse(match?.[2]);
    return match && key.success ? { kind: match[1] === "inbox" ? "note" : "topic", key: key.data, path } : undefined;
}
export function isMemoryStoragePath(storage: PillarStorageLayout, path: string): boolean {
    const rel = relative(storage.projectsRoot, resolve(path));
    return !rel.startsWith("..") && /^[^/]+\/memory(?:\/|$)/.test(rel);
}
export async function checkMemoryStoragePath(storage: PillarStorageLayout, path: string): Promise<boolean> {
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
export function createPublicationFileAccess(store: MemoryPublicationStore, owner: {
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
}): PublicationFileAccess {
    const requirePath = (path: string) => {
        const managed = classifyPublicationPath(store.directory, path);
        if (!managed)
            throw new Error("Memory path is not a public note/topic view in the current project");
        return managed;
    };
    return {
        directory: store.directory,
        classify: path => classifyPublicationPath(store.directory, path),
        async prepare(path, toolName) {
            const managed = requirePath(path);
            const reading = toolName === "read_file" || toolName === "grep";
            const writingNote = managed.kind === "note" && (toolName === "write_file" || toolName === "edit_file");
            const forgetting = managed.kind !== "index" && toolName === "delete_file";
            if (!reading && !writingNote && !forgetting)
                throw new Error("Published Memory is read-only. Write inbox notes to remember/correct; delete a previously read topic to forget.");
            const view = await store.prepareView(managed);
            if (!view && !writingNote)
                throw new Error("Memory content does not exist or was revoked");
        },
        validateWrite(path, content) {
            if (requirePath(path).kind !== "note")
                throw new Error("Submit Memory through inbox notes; do not edit published topics or indexes directly");
            parseMemoryNote(content);
        },
        async write(path, content, expectedContent, toolCallId) {
            const managed = requirePath(path);
            if (managed.kind !== "note")
                throw new Error("Only Memory notes can be written");
            const note = parseMemoryNote(content);
            await store.acceptNote(managed.key, note, { kind: "explicit", sessionId: owner.sessionId, turnId: owner.turnId, toolCallId }, expectedContent, owner.signal);
            return { action: expectedContent === null ? "created" : "updated", key: managed.key, memoryType: note.type };
        },
        async delete(path, expectedContent) {
            const managed = requirePath(path);
            if (managed.kind === "index")
                throw new Error("Cannot delete the Memory index");
            const snapshot = store.snapshot();
            const type = snapshot.sources.findLast(source => source.key === managed.key)?.type ?? snapshot.topics.find(topic => topic.key === managed.key)?.type;
            const removed = await store.forget(managed.key, owner.signal, { kind: managed.kind, content: expectedContent });
            return removed && type ? { action: "forgotten", key: managed.key, memoryType: type } : undefined;
        },
    };
}
