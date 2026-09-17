import {z} from "zod";
import {readFile, stat} from "node:fs/promises";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";
import {createFileChange} from "../../fileChanges/index.js";
import {commitFileWrite} from "../shared/fileWrite.js";

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

function overwriteStateMessage(
    path: string,
    reason: "not_read" | "partial_read" | "stale"
): string {
    if (reason === "partial_read") {
        return `Before replacing all of ${path} , read it fully with read_file; a partial read is insufficient for a safe overwrite.`;
    }
    if (reason === "stale") {
        return `File ${path} has changed since the last read_file; read it again.`;
    }
    return `Before overwriting existing file ${path}, read it fully with read_file (to prevent stale writes). Bash cat and other tools do not establish this read record. No file was written.`;
}

export const writeFileTool: Tool<
    z.ZodObject<{
        path: z.ZodString;
        content: z.ZodString;
    }>
> = {
    name: "write_file",
    description:
        "Create a file or replace its entire contents. Read an existing file fully with read_file before rewriting it; Bash cat does not establish the required read record. Use edit_file for local changes. Provide complete working content, not a placeholder awaiting mechanical follow-up writes. User-supplied text and identifiers retain their intended language.",
    parameters: z.object({
        path: z.string().describe("File path."),
        content: z.string().describe("Complete file contents."),
    }),
    isReadOnly: () => false,
    getDefaultApprovalScope: ({path}) => ({kind: "workspace", path}),
    async checkPermissions({path, content}, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const exists = await fileExists(absPath);

        if (ctx.memoryFiles?.classify(absPath)) {
            return {behavior: "allow" as const};
        }

        return {
            behavior: "ask",
            message: `${exists ? "About to overwrite existing file" : "About to write new file"}:\n  ${path}\n  (${content.length} characters)\nProceed?`,
        };
    },
    execute: async (
        {path, content},
        ctx,
        invocation
    ) => {
        // Permissions already passed; execute directly.
        // Create missing parent directories.
        const absPath = resolveToolPath(ctx.cwd, path);
        if (ctx.memoryFiles?.classify(absPath)) {
            ctx.memoryFiles.validateWrite(absPath, content);
        }
        const exists = await fileExists(absPath);
        const oldContent = exists ? await readFile(absPath, "utf-8") : "";
        if (exists) {
            const state = ctx.fileState.check(absPath, oldContent, {
                requireFullRead: true,
            });
            if (!state.ok) {
                return {
                    content: `Write precondition failed: ${overwriteStateMessage(path, state.reason)}`,
                    outcome: "failed" as const,
                };
            }
        }
        if (exists && oldContent === content) {
            return `No write needed for ${path}(content unchanged)`;
        }
        if (ctx.memoryFiles?.classify(absPath)) {
            await ctx.memoryFiles.write(
                absPath,
                content,
                exists ? oldContent : null,
                invocation.toolCallId
            );
            ctx.fileState.forget(absPath);
            return `Memory note recorded and available for recall; pending consolidation: ${path}. Read the normalized note before further changes; no index maintenance is needed.`;
        }
        const change = createFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: exists ? "update" : "create",
            oldContent,
            newContent: content,
        });

        const {identity} = await commitFileWrite({
            coordinator: ctx.fileCommits,
            signal: ctx.signal,
            path: absPath,
            beforeContent: exists ? oldContent : null,
            afterContent: content,
        });
        ctx.fileState.recordWrite({
            identity,
            path: absPath,
            content,
            modelKnowsWholeFile: true,
        });
        const result =
            `Wrote ${path} (${content.length} characters)`;
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
