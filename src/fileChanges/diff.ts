import {structuredPatch} from "diff";
import type {DiffHunk, DiffLine, DiffLineType, FileChange,} from "./types.js";

const DIFF_CONTEXT_LINES = 3;
const DIFF_TIMEOUT_MS = 5_000;
const MAX_FILE_CHANGE_UI_BYTES = 2 * 1024 * 1024;

export interface CreateFileChangeInput {
    path: string;
    kind: "create" | "update" | "delete";
    oldContent: string;
    newContent: string;
    replacements?: number;
}

export interface FileChangeContents {
    oldContent: string;
    newContent: string;
}

// Full contents exist only to merge consecutive changes in the current process. WeakMap is not serialized
// into Sessions, Headless JSON or Tool Results; only bounded structured diffs cross persistence boundaries.
const fileChangeContents = new WeakMap<FileChange, FileChangeContents>();

export function getFileChangeContents(
    change: FileChange
): FileChangeContents | undefined {
    return fileChangeContents.get(change);
}

function rememberContents(
    change: FileChange,
    input: CreateFileChangeInput
): FileChange {
    fileChangeContents.set(change, {
        oldContent: input.oldContent,
        newContent: input.newContent,
    });
    return change;
}

function lineType(line: string): DiffLineType | null {
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "remove";
    if (line.startsWith(" ")) return "context";
    return null;
}

export function convertUnifiedDiffHunk(hunk: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}): DiffHunk {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines: DiffLine[] = [];

    for (const rawLine of hunk.lines) {
        const type = lineType(rawLine);
        // "\\ No newline at end of file" is patch metadata, not source content.
        if (!type) continue;
        const content = rawLine.slice(1).replace(/\r$/, "");
        if (type === "context") {
            lines.push({
                type,
                content,
                oldLineNumber: oldLine++,
                newLineNumber: newLine++,
            });
        } else if (type === "remove") {
            lines.push({type, content, oldLineNumber: oldLine++});
        } else {
            lines.push({type, content, newLineNumber: newLine++});
        }
    }

    return {
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines,
    };
}

function countVisibleContentLines(content: string): number {
    if (content.length === 0) return 0;
    const normalized = content.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n");
    return normalized.endsWith("\n") ? parts.length - 1 : parts.length;
}

function normalizeForDisplayDiff(content: string): string {
    if (content.length === 0 || content.endsWith("\n")) return content;
    return `${content}\n`;
}

function unavailableChange(
    input: CreateFileChangeInput,
    reason: "timeout" | "error"
): FileChange {
    return {
        version: 1,
        path: input.path,
        kind: input.kind,
        hunks: [],
        linesAdded: null,
        linesRemoved: null,
        ...(input.replacements === undefined
            ? {}
            : {replacements: input.replacements}),
        diffStatus: "unavailable",
        diffUnavailableReason: reason,
    };
}

export function createFileChange(input: CreateFileChangeInput): FileChange {
    try {
        const normalizedOld = normalizeForDisplayDiff(input.oldContent);
        const normalizedNew = normalizeForDisplayDiff(input.newContent);
        const onlyEndOfFileNewlineChanged =
            input.oldContent !== input.newContent && normalizedOld === normalizedNew;
        const patch = structuredPatch(
            input.path,
            input.path,
            onlyEndOfFileNewlineChanged ? input.oldContent : normalizedOld,
            onlyEndOfFileNewlineChanged ? input.newContent : normalizedNew,
            undefined,
            undefined,
            {
                context: DIFF_CONTEXT_LINES,
                timeout: DIFF_TIMEOUT_MS,
                stripTrailingCr: true,
            }
        );
        if (!patch) {
            return rememberContents(unavailableChange(input, "timeout"), input);
        }

        const hunks = patch.hunks.map(convertUnifiedDiffHunk);
        let linesAdded = 0;
        let linesRemoved = 0;
        for (const hunk of hunks) {
            for (const line of hunk.lines) {
                if (line.type === "add") linesAdded += 1;
                if (line.type === "remove") linesRemoved += 1;
            }
        }

        // diff treats a trailing empty patch line as metadata. For a brand-new
        // file, make the user-facing count match editor line numbering exactly.
        if (input.kind === "create") {
            linesAdded = countVisibleContentLines(input.newContent);
        } else if (input.kind === "delete") {
            linesRemoved = countVisibleContentLines(input.oldContent);
        }

        return rememberContents(
            limitFileChangeUIData({
                version: 1,
                path: input.path,
                kind: input.kind,
                hunks,
                linesAdded,
                linesRemoved,
                ...(input.replacements === undefined
                    ? {}
                    : {replacements: input.replacements}),
                diffStatus: "complete",
            }),
            input
        );
    } catch {
        return rememberContents(unavailableChange(input, "error"), input);
    }
}

function limitFileChangeUIData(change: FileChange): FileChange {
    const maxBytes = MAX_FILE_CHANGE_UI_BYTES;
    if (Buffer.byteLength(JSON.stringify(change), "utf8") <= maxBytes) {
        return change;
    }

    const hunks: DiffHunk[] = [];
    let keptLines = 0;
    const totalLines = change.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.length,
        0
    );
    const base: FileChange = {
        ...change,
        hunks: [],
        diffStatus: "truncated",
        omittedDiffLines: totalLines,
    };
    let estimatedBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    outer: for (const hunk of change.hunks) {
        const next: DiffHunk = {...hunk, lines: []};
        estimatedBytes += Buffer.byteLength(
            JSON.stringify({...hunk, lines: []}),
            "utf8"
        ) + 1;
        if (estimatedBytes > maxBytes) break;
        for (const line of hunk.lines) {
            const lineBytes = Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
            if (estimatedBytes + lineBytes > maxBytes) {
                if (next.lines.length > 0) hunks.push(next);
                break outer;
            }
            next.lines.push(line);
            estimatedBytes += lineBytes;
            keptLines += 1;
        }
        if (next.lines.length > 0) hunks.push(next);
    }
    const limited: FileChange = {
        ...change,
        hunks,
        diffStatus: "truncated",
        omittedDiffLines: totalLines - keptLines,
    };
    // The estimate intentionally includes conservative separators. Keep a final
    // defensive trim for unusually large path/metadata fields.
    while (
        Buffer.byteLength(JSON.stringify(limited), "utf8") > maxBytes &&
        limited.hunks.length > 0
        ) {
        const lastHunk = limited.hunks.at(-1)!;
        if (lastHunk.lines.length > 0) {
            lastHunk.lines.pop();
            limited.omittedDiffLines = (limited.omittedDiffLines ?? 0) + 1;
        }
        if (lastHunk.lines.length === 0) limited.hunks.pop();
    }
    return limited;
}
