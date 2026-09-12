import {readFileSnapshot} from "../shared/fileSnapshot.js";
import {z} from "zod";
import {createByteFileChange} from "../../fileChanges/index.js";
import {commitFileWrite} from "../shared/fileWrite.js";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";

const inputSchema = z.object({
    path: z.string().describe("File to delete; first identify its current version with read_file."),
});

type Input = z.infer<typeof inputSchema>;

function readRequirement(path: string, reason: "not_read" | "partial_read" | "stale"): string {
    if (reason === "stale") return `File ${path} has changed since the last read_file; read it again.`;
    return `Delete ${path} only after read_file confirms its current version.`;
}

export const deleteFileTool: Tool<typeof inputSchema> = {
    name: "delete_file",
    description: "Delete a regular file after read_file has identified its current version, including binary assets. Project files pass normal permissions and safe-write validation; Memory topics use the managed Memory boundary. Do not delete unrelated user files.",
    parameters: inputSchema,
    isReadOnly: () => false,
    getDefaultApprovalScope: ({path}) => ({kind: "workspace", path}),

    async checkPermissions({path}: Input, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        let snapshot: Awaited<ReturnType<typeof readFileSnapshot>>;
        try {
            snapshot = await readFileSnapshot(absPath);
        } catch (error) {
            return {
                behavior: "deny" as const,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        const state = ctx.fileState.check(absPath, snapshot.content, {identity: ctx.memoryFiles?.classify(absPath) ? undefined : snapshot.identity, requireFullRead: Boolean(ctx.memoryFiles?.classify(absPath))});
        if (!state.ok) {
            return {behavior: "deny" as const, message: readRequirement(path, state.reason)};
        }
        const memoryPath = ctx.memoryFiles?.classify(absPath);
        if (memoryPath) {
            return memoryPath.kind !== "index"
                ? {behavior: "allow" as const}
                : {behavior: "deny" as const, message: "MEMORY.md is a fixed entry point and cannot be deleted"};
        }
        return {behavior: "ask" as const, message: `About to delete file: ${path}\nRun this command?`};
    },

    async execute({path}: Input, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const snapshot = await readFileSnapshot(absPath);
        const state = ctx.fileState.check(absPath, snapshot.content, {identity: ctx.memoryFiles?.classify(absPath) ? undefined : snapshot.identity, requireFullRead: Boolean(ctx.memoryFiles?.classify(absPath))});
        if (!state.ok) return {content: `Deletion cancelled: ${readRequirement(path, state.reason)}`, outcome: "failed" as const};

        const memoryPath = ctx.memoryFiles?.classify(absPath);
        if (memoryPath) {
            if (memoryPath.kind === "index") return {content: "Deletion cancelled: MEMORY.md cannot be deleted", outcome: "failed" as const};
            await ctx.memoryFiles!.delete(absPath, snapshot.content.toString("utf8"));
            ctx.fileState.forget(absPath);
            return `Memory content revoked: ${path}`;
        }

        const change = createByteFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: "delete",
            oldContent: snapshot.content,
            newContent: Buffer.alloc(0),
        });
        await commitFileWrite({
            coordinator: ctx.fileCommits,
            signal: ctx.signal,
            path: absPath,
            beforeContent: snapshot.content,
            afterContent: null,
        });
        ctx.fileState.forget(absPath);
        const result = `Deleted ${path}`;
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
