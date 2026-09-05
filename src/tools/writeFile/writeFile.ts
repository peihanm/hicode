import {z} from "zod";
import {readFile, stat} from "node:fs/promises";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";
import {createFileChange} from "../../fileChanges/index.js";
import {formatCheckpointWarnings, runTrackedFileWrite,} from "../../checkpoints/index.js";

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
        return `整体覆盖 ${path} 前必须先完整 read_file，部分读取不足以安全覆盖文件。`;
    }
    if (reason === "stale") {
        return `文件 ${path} 自上次 read_file 后已被修改，必须重新读取。`;
    }
    return `覆盖已有文件 ${path} 前必须先用 read_file 完整读取它（防止脏改）。`;
}

export const writeFileTool: Tool<
    z.ZodObject<{
        path: z.ZodString;
        content: z.ZodString;
    }>
> = {
    name: "write_file",
    description:
        "创建文件或整体重写文件。整体重写时必须已完整掌握当前版本；此前未读取的已有文件要先用 read_file 完整读取，小范围修改优先用 edit_file。",
    parameters: z.object({
        path: z.string().describe("文件路径"),
        content: z.string().describe("完整的文件内容"),
    }),
    isReadOnly: () => false,
    getDefaultApprovalScope: ({path}) => ({kind: "workspace", path}),
    async checkPermissions({path, content}, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const exists = await fileExists(absPath);

        if (ctx.memoryFiles?.classify(absPath)) {
            try {
                ctx.memoryFiles.validateWrite(absPath, content);
                return {behavior: "allow" as const};
            } catch (error) {
                return {
                    behavior: "deny" as const,
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        }

        return {
            behavior: "ask",
            message: `${exists ? "即将覆盖已有文件" : "即将写入新文件"}:\n  ${path}\n  (${content.length} 字符)\n是否执行?`,
        };
    },
    execute: async (
        {path, content},
        ctx,
        invocation
    ) => {
        // 到这里时权限已经通过，直接执行
        // 父目录不存在则创建
        const absPath = resolveToolPath(ctx.cwd, path);
        const exists = await fileExists(absPath);
        const oldContent = exists ? await readFile(absPath, "utf-8") : "";
        if (exists) {
            const state = ctx.fileState.check(absPath, oldContent, {
                requireFullRead: true,
            });
            if (!state.ok) {
                return {
                    content: `写入前置条件未满足: ${overwriteStateMessage(path, state.reason)}`,
                    outcome: "failed" as const,
                };
            }
        }
        if (exists && oldContent === content) {
            return `无需写入 ${path}（内容未发生变化）`;
        }
        if (ctx.memoryFiles?.classify(absPath)) {
            await ctx.memoryFiles.write(
                absPath,
                content,
                exists ? oldContent : null
            );
            ctx.fileState.recordWrite({
                path: absPath,
                content,
                modelKnowsWholeFile: true,
            });
            return `Memory 文件已写入: ${path}`;
        }
        const change = createFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: exists ? "update" : "create",
            oldContent,
            newContent: content,
        });

        const {warnings: checkpointWarnings, identity} = await runTrackedFileWrite({
            runtime: ctx.fileCheckpoints,
            coordinator: ctx.fileCommits,
            signal: ctx.signal,
            path: absPath,
            beforeContent: exists ? oldContent : null,
            afterContent: content,
            toolCallId: invocation.toolCallId,
        });
        ctx.fileState.recordWrite({
            identity,
            path: absPath,
            content,
            modelKnowsWholeFile: true,
        });
        const result =
            `已写入 ${path}（${content.length} 字符）` +
            formatCheckpointWarnings(checkpointWarnings);
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
