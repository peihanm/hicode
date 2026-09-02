import {z} from "zod";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import type {Tool} from "../types.js";
import {getPostWriteDiagnostics} from "../shared/lspDiagnostics.js";
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
        overwrite_existing: z.ZodDefault<z.ZodBoolean>;
    }>
> = {
    name: "write_file",
    description:
        "写入文件。默认只用于新建文件；覆盖已有文件必须显式传 overwrite_existing=true，且覆盖前必须先用 read_file 完整读取当前版本。修改已有文件优先用 edit_file。",
    parameters: z.object({
        path: z.string().describe("文件路径"),
        content: z.string().describe("完整的文件内容"),
        overwrite_existing: z
            .boolean()
            .default(false)
            .describe("是否允许覆盖已有文件。默认 false；覆盖前必须先完整 read_file 目标文件"),
    }),
    isReadOnly: () => false,
    getDefaultApprovalScope: ({path}) => ({kind: "workspace", path}),
    async checkPermissions({path, content, overwrite_existing}, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const exists = await fileExists(absPath);
        if (exists) {
            if (!overwrite_existing) {
                return {
                    behavior: "deny" as const,
                    message:
                        `文件已存在: ${path}。` +
                        "若要局部修改请用 edit_file；若确实要整体覆盖，请先 read_file 后再传 overwrite_existing=true。",
                };
            }
            const currentContent = await readFile(absPath, "utf-8");
            const state = ctx.fileState.check(absPath, currentContent, {
                requireFullRead: true,
            });
            if (!state.ok) {
                return {
                    behavior: "deny" as const,
                    message: overwriteStateMessage(path, state.reason),
                };
            }
        }

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
        {path, content, overwrite_existing},
        ctx,
        invocation
    ) => {
        // 到这里时权限已经通过，直接执行
        // 父目录不存在则创建
        const absPath = resolveToolPath(ctx.cwd, path);
        const exists = await fileExists(absPath);
        if (exists && !overwrite_existing) {
            return `写入取消: 文件已存在 ${path}。请使用 edit_file，或先 read_file 后传 overwrite_existing=true。`;
        }
        const oldContent = exists ? await readFile(absPath, "utf-8") : "";
        if (exists) {
            const state = ctx.fileState.check(absPath, oldContent, {
                requireFullRead: true,
            });
            if (!state.ok) {
                return `写入取消: ${overwriteStateMessage(path, state.reason)}`;
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
                observedContent: content,
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

        const checkpointWarnings = await runTrackedFileWrite({
            runtime: ctx.fileCheckpoints,
            path: absPath,
            beforeContent: exists ? oldContent : null,
            afterContent: content,
            toolCallId: invocation.toolCallId,
            write: async () => {
                await mkdir(dirname(absPath), {recursive: true});
                await writeFile(absPath, content, "utf-8");
            },
        });
        ctx.fileState.recordWrite({
            path: absPath,
            content,
            observedContent: content,
            modelKnowsWholeFile: true,
        });
        const diagnostics = await getPostWriteDiagnostics(absPath, content, ctx);

        const result =
            `已写入 ${path}（${content.length} 字符）${diagnostics}` +
            formatCheckpointWarnings(checkpointWarnings);
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
