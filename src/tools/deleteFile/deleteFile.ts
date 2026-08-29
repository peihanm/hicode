import {readFile, stat, unlink} from "node:fs/promises";
import {z} from "zod";
import {createFileChange} from "../../fileChanges/index.js";
import {formatCheckpointWarnings, runTrackedFileWrite,} from "../../checkpoints/index.js";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";

const inputSchema = z.object({
    path: z.string().describe("要删除的文件路径。删除前必须先用 read_file 完整读取当前版本。"),
});

type Input = z.infer<typeof inputSchema>;

async function readRegularFile(path: string): Promise<string> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("delete_file 只能删除普通文件");
    return readFile(path, "utf8");
}

function readRequirement(path: string, reason: "not_read" | "partial_read" | "stale"): string {
    if (reason === "stale") return `文件 ${path} 自上次 read_file 后已被修改，必须重新读取。`;
    return `删除 ${path} 前必须先用 read_file 完整读取当前版本。`;
}

export const deleteFileTool: Tool<typeof inputSchema> = {
    name: "delete_file",
    description: "删除普通文件。删除前必须完整读取；项目文件进入权限和 Checkpoint，Memory 主题通过受管 Memory 边界删除。",
    parameters: inputSchema,
    isReadOnly: () => false,

    async checkPermissions({path}: Input, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        let content: string;
        try {
            content = await readRegularFile(absPath);
        } catch (error) {
            return {
                behavior: "deny" as const,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        const state = ctx.fileState.check(absPath, content, {requireFullRead: true});
        if (!state.ok) {
            return {behavior: "deny" as const, message: readRequirement(path, state.reason)};
        }
        const memoryPath = ctx.memoryFiles?.classify(absPath);
        if (memoryPath) {
            return memoryPath.kind === "topic"
                ? {behavior: "allow" as const}
                : {behavior: "deny" as const, message: "MEMORY.md 是固定入口，不能删除"};
        }
        return {behavior: "ask" as const, message: `即将删除文件: ${path}\n是否执行?`};
    },

    async execute({path}: Input, ctx, invocation) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const content = await readRegularFile(absPath);
        const state = ctx.fileState.check(absPath, content, {requireFullRead: true});
        if (!state.ok) return `删除取消: ${readRequirement(path, state.reason)}`;

        const memoryPath = ctx.memoryFiles?.classify(absPath);
        if (memoryPath) {
            if (memoryPath.kind !== "topic") return "删除取消: MEMORY.md 不能删除";
            await ctx.memoryFiles!.delete(absPath, content);
            ctx.fileState.recordWrite({
                path: absPath,
                content: "",
                observedContent: "",
                modelKnowsWholeFile: true,
            });
            return `Memory 主题已删除: ${path}`;
        }

        const change = createFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: "delete",
            oldContent: content,
            newContent: "",
        });
        const warnings = await runTrackedFileWrite({
            runtime: ctx.fileCheckpoints,
            path: absPath,
            beforeContent: content,
            afterContent: null,
            toolCallId: invocation.toolCallId,
            write: () => unlink(absPath),
        });
        ctx.fileState.recordWrite({
            path: absPath,
            content: "",
            observedContent: "",
            modelKnowsWholeFile: true,
        });
        const result = `已删除 ${path}${formatCheckpointWarnings(warnings)}`;
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
