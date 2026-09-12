import {createFileChange, getFileChangeContents} from "./diff.js";
import type {FileChange} from "./types.js";

function samePathIndices(changes: FileChange[], path: string): number[] {
    return changes.flatMap((change, index) =>
        change.path === path ? [index] : []
    );
}

function coalesceFileChanges(
    previous: FileChange,
    next: FileChange
): FileChange | null {
    if (previous.path !== next.path) return null;
    const before = getFileChangeContents(previous);
    const after = getFileChangeContents(next);
    if (!before || !after || before.newContent !== after.oldContent) return null;

    const merged = createFileChange({
        path: previous.path,
        kind:
            before.oldContent.length === 0 && after.newContent.length > 0
                ? "create"
                : before.oldContent.length > 0 && after.newContent.length === 0
                    ? "delete"
                    : "update",
        oldContent: before.oldContent,
        newContent: after.newContent,
        replacements:
            previous.replacements === undefined && next.replacements === undefined
                ? undefined
                : (previous.replacements ?? 0) + (next.replacements ?? 0),
    });
    merged.scope = "turn";
    return merged;
}

/** Fold consecutive changes for the same turn/path into a baseline-to-final diff. A persisted turn-scoped change replaces earlier tool-scoped changes, so Session recovery does not depend on process-local full contents. */
export function mergeFileChange(
    changes: FileChange[],
    incoming: FileChange
): FileChange[] {
    const indices = samePathIndices(changes, incoming.path);
    if (indices.length === 0) return [...changes, incoming];

    const firstIndex = indices[0]!;
    const latest = changes[indices.at(-1)!]!;
    const merged = incoming.scope === "turn"
        ? incoming
        : coalesceFileChanges(latest, incoming);
    if (!merged) return [...changes, incoming];

    return changes.flatMap((change, index) => {
        if (change.path !== incoming.path) return [change];
        return index === firstIndex ? [merged] : [];
    });
}

export function mergeFileChanges(changes: FileChange[]): FileChange[] {
    return changes.reduce(mergeFileChange, [] as FileChange[]);
}
