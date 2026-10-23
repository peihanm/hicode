import {createFileChange, getFileChangeContents} from "./diff.js";
import type {FileChange} from "./diff.js";

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
    // Empty contents do not imply absence. Creation/deletion must also connect.
    if ((previous.kind !== "delete") !== (next.kind !== "create")) return null;
    // FileChange has no absent-to-absent kind; retain both operations.
    if (previous.kind === "create" && next.kind === "delete") return null;
    const before = getFileChangeContents(previous);
    const after = getFileChangeContents(next);
    if (!before || !after || before.newContent !== after.oldContent) return null;

    const merged = createFileChange({
        path: previous.path,
        kind:
            previous.kind === "create"
                ? "create"
                : next.kind === "delete"
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
    // Multiple records mean continuity was lost. A partial merge must not be
    // labelled turn-wide: persistence/replay would discard earlier segments.
    if (indices.length > 1) return [...changes, incoming];

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
