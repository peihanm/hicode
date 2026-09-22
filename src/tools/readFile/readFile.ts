import {z} from "zod";
import {isUtf8} from "node:buffer";
import {createHash} from "node:crypto";
import {readFileSnapshot} from "../shared/fileSnapshot.js";
import type {Tool} from "../types.js";
import {normalizeFileText} from "../shared/fileState.js";
import {resolveToolPath} from "../shared/paths.js";
import {readSavedOutput} from "./savedOutput.js";
import {resolveSessionArchiveFile} from "../../session/archiveAccess.js";
import {isMemoryStoragePath} from "../../memory/publicationAccess.js";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const inputSchema = z.object({
    path: z.string().describe("Absolute or relative file path."),
    offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            "Optional 1-based start line. Omit for ordinary files; use for a known range or files exceeding one read."
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(
            "Optional line count; omit for ordinary files (up to 2000 lines by default). Use for a known range or larger file, maximum 2000."
        ),
});

type Input = z.infer<typeof inputSchema>;

function formatLineNumber(lineNumber: number): string {
    return String(lineNumber).padStart(6, " ");
}

export const readFileTool: Tool<typeof inputSchema> = {
    name: "read_file",
    description: "Read a local file with line numbers. For a known ordinary file, omit offset/limit to read it in one call (up to 2000 lines); use ranges only for known locations or larger files. Line-number prefixes are not file content: exclude them from edit_file replacements. Saved tool-result/archive paths also accept line-based offset/limit, but reading a log does not establish the current source-file version. Binary assets or text over 5 MiB return metadata only, sufficient to identify a deletion target but not to authorize text editing; files over 20 MiB are rejected. Use view_image for pixels: a binary summary is not image understanding.",
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async ({path, offset, limit}: Input, ctx, invocation) => {
        const absPath = resolveToolPath(ctx.cwd, path);
        if (isMemoryStoragePath(ctx.storage, absPath)) {
            if (!ctx.memoryFiles) throw new Error("This Agent has no Memory file capability");
            await ctx.memoryFiles.prepare(absPath, "read_file");
        }
        const archive = await resolveSessionArchiveFile(ctx.storage, ctx.sessionArchives, absPath);
        if (archive) return readSavedOutput(archive, offset ?? 1, limit ?? DEFAULT_LIMIT, ctx.signal, "archive");
        const saved = await ctx.toolResultFiles.resolveFile(absPath);
        if (saved) return readSavedOutput(saved, offset ?? 1, limit ?? DEFAULT_LIMIT, ctx.signal);
        const snapshot = await readFileSnapshot(absPath);
        const binary = !isUtf8(snapshot.content) || snapshot.content.includes(0);
        if (snapshot.content.length > MAX_FILE_SIZE || binary) {
            const output = [
                `File: ${path}`,
                `Type: ${binary ? "binary" : "large text"}`,
                `Size: ${snapshot.content.length} bytes`,
                `SHA256: ${createHash("sha256").update(snapshot.content).digest("hex")}`,
                "Contents were not shown and cannot authorize edit_file/write_file.",
            ].join("\n");
            return output;
        }
        const content = snapshot.content.toString("utf8");
        const normalized = normalizeFileText(content);
        const lines = normalized.split("\n");
        const startLine = offset ?? 1;
        const lineLimit = limit ?? DEFAULT_LIMIT;
        if (startLine > lines.length) {
            return `File ${path} has ${lines.length} lines; offset=${startLine} is out of range.`;
        }

        const startIndex = startLine - 1;
        const endIndex = Math.min(startIndex + lineLimit, lines.length);
        const selected = lines.slice(startIndex, endIndex);
        const body = selected
            .map((line, index) => `${formatLineNumber(startLine + index)}\t${line}`)
            .join("\n");

        const header = [
            `File: ${path}`,
            `Line range: ${startLine}-${endIndex} / ${lines.length}`,
            "Note: left-hand line numbers are not file content; exclude them from edit_file.edits[].old_string.",
        ].join("\n");

        const more =
            endIndex < lines.length
                ? `\n\n... (remaining lines omitted: ${lines.length - endIndex} )`
                : "";

        const output = `${header}\n\n${body}${more}`;
        let outputByte = Buffer.byteLength(`${header}\n\n`);
        let fileByte = Buffer.byteLength(lines.slice(0, startIndex).join("\n")) + (startIndex > 0 ? 1 : 0);
        const segments = selected.map((line, index): readonly [number, number, number] => {
            const prefix = Buffer.byteLength(`${formatLineNumber(startLine + index)}\t`);
            const bytes = Buffer.byteLength(line) + (startIndex + index < lines.length - 1 ? 1 : 0);
            const segment = [outputByte + prefix, outputByte + prefix + bytes, fileByte] as const;
            outputByte += prefix + Buffer.byteLength(line) + 1;
            fileByte += bytes;
            return segment;
        });
        ctx.fileState.stageRead({toolCallId: invocation.toolCallId, path: absPath, content,
            normalizedBytes: Buffer.byteLength(normalized), output, segments});
        return output;
    },
};
