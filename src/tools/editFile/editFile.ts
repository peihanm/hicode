import {z} from "zod";
import {readFile, writeFile} from "node:fs/promises";
import type {Tool, ToolContext} from "../types.js";
import {getPostWriteDiagnostics} from "../shared/lspDiagnostics.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";
import {countOccurrences, findActualString} from "./strMatch.js";
import {formatDiff} from "./utils.js";
import {createFileChange} from "../../fileChanges/index.js";
import {formatCheckpointWarnings, runTrackedFileWrite,} from "../../checkpoints/index.js";

interface EditValidation {
    originalContent: string;
    normalizedContent: string;
    lineEnding: "\n" | "\r\n";
    count: number;
    match: ReturnType<typeof findActualString>;
}

function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(
    content: string,
    lineEnding: "\n" | "\r\n"
): string {
    return lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function readStateMessage(
    path: string,
    reason: "not_read" | "partial_read" | "stale"
): string {
    if (reason === "partial_read") {
        return `read_file 未展示要修改的完整内容。请定点读取 ${path} 中包含 old_string 的区间；replace_all 必须先完整读取文件。`;
    }
    if (reason === "stale") {
        return `文件 ${path} 自上次 read_file 后已被修改，必须重新读取。`;
    }
    return `必须先用 read_file 读取 ${path} 后才能修改（防止脏改）`;
}

async function validateEdit(
    path: string,
    oldString: string,
    replaceAll: boolean,
    ctx: ToolContext
): Promise<{ ok: true; value: EditValidation } | { ok: false; message: string }> {
    if (oldString.length === 0) {
        return {ok: false, message: "old_string 不能为空。"};
    }

    let originalContent: string;
    try {
        originalContent = await readFile(path, "utf-8");
    } catch (err) {
        return {
            ok: false,
            message: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const state = ctx.fileState.check(path, originalContent, {
        oldString,
        replaceAll,
    });
    if (!state.ok) {
        return {ok: false, message: readStateMessage(path, state.reason)};
    }

    const normalizedContent = normalizeLineEndings(originalContent);
    const normalizedOldString = normalizeLineEndings(oldString);

    const match = findActualString(normalizedContent, normalizedOldString);
    const count = countOccurrences(normalizedContent, normalizedOldString);
    if (match.index === -1 || count === 0) {
        return {
            ok: false,
            message: `在 ${path} 中找不到 old_string。请确认字符串是否完全一致（包括空格、缩进、换行）。`,
        };
    }

    if (!replaceAll && count > 1) {
        return {
            ok: false,
            message:
                `old_string 在 ${path} 中匹配到 ${count} 处，但 replace_all=false。\n` +
                `请提供更长的上下文使匹配唯一，或显式传 replace_all=true 替换全部。`,
        };
    }

    return {
        ok: true,
        value: {
            originalContent,
            normalizedContent,
            lineEnding: originalContent.includes("\r\n") ? "\r\n" : "\n",
            count,
            match,
        },
    };
}

export const editFileTool: Tool<
    z.ZodObject<{
        path: z.ZodString;
        old_string: z.ZodString;
        new_string: z.ZodString;
        replace_all: z.ZodDefault<z.ZodBoolean>;
    }>
> = {
    name: "edit_file",
    description:
        "用 search-and-replace 精确修改文件：找到 old_string 换成 new_string。" +
        "修改前必须先 read_file 读过当前版本；部分读取只能修改模型实际看到的 old_string。" +
        "old_string 必须能在文件中唯一匹配；replace_all=true 时必须先完整读取文件。",
    parameters: z.object({
        path: z.string().describe("要修改的文件路径"),
        old_string: z.string().min(1).describe("要被替换的精确字符串"),
        new_string: z.string().describe("替换后的新内容"),
        replace_all: z
            .boolean()
            .default(false)
            .describe("是否替换所有匹配。默认 false（要求 old_string 唯一匹配）"),
    }),
    isReadOnly: () => false,
    async checkPermissions({path, old_string, new_string, replace_all}, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const validation = await validateEdit(absPath, old_string, replace_all, ctx);
        if (!validation.ok) {
            return {
                behavior: "deny" as const,
                message: validation.message,
            };
        }

        if (ctx.memoryFiles?.classify(absPath)) {
            const normalizedNewString = normalizeLineEndings(new_string);
            const {normalizedContent, lineEnding, match} = validation.value;
            const normalizedNewContent = replace_all
                ? normalizedContent.split(match.actualString).join(normalizedNewString)
                : normalizedContent.slice(0, match.index) +
                  normalizedNewString +
                  normalizedContent.slice(match.index + match.actualString.length);
            try {
                ctx.memoryFiles.validateWrite(
                    absPath,
                    restoreLineEndings(normalizedNewContent, lineEnding)
                );
                return {behavior: "allow" as const};
            } catch (error) {
                return {
                    behavior: "deny" as const,
                    message: error instanceof Error ? error.message : String(error),
                };
            }
        }

        const preview = formatDiff(old_string, new_string);
        return {
            behavior: "ask" as const,
            message: `即将修改 ${path}（${validation.value.count} 处匹配，replace_all=${replace_all}）:\n${preview}\n是否执行?`,
        };
    },
    execute: async (
        {path, old_string, new_string, replace_all},
        ctx,
        invocation
    ) => {
        const absPath = resolveToolPath(ctx.cwd, path);
        const validation = await validateEdit(absPath, old_string, replace_all, ctx);
        if (!validation.ok) {
            return `编辑取消: ${validation.message} 请重新 read_file 后再修改。`;
        }

        const {
            originalContent,
            normalizedContent,
            lineEnding,
            count,
            match,
        } = validation.value;
        const normalizedNewString = normalizeLineEndings(new_string);

        let normalizedNewContent: string;
        if (replace_all) {
            const actualStr = match.actualString;
            normalizedNewContent = normalizedContent
                .split(actualStr)
                .join(normalizedNewString);
        } else {
            normalizedNewContent =
                normalizedContent.slice(0, match.index) +
                normalizedNewString +
                normalizedContent.slice(match.index + match.actualString.length);
        }
        const newContent = restoreLineEndings(normalizedNewContent, lineEnding);

        if (newContent === originalContent) {
            return `无需修改 ${path}（内容未发生变化）`;
        }

        if (ctx.memoryFiles?.classify(absPath)) {
            await ctx.memoryFiles.write(absPath, newContent, originalContent);
            ctx.fileState.recordWrite({
                path: absPath,
                content: newContent,
                observedContent: normalizedNewString,
            });
            return `Memory 文件已修改: ${path}`;
        }

        const change = createFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: "update",
            oldContent: originalContent,
            newContent,
            replacements: count,
        });

        const checkpointWarnings = await runTrackedFileWrite({
            runtime: ctx.fileCheckpoints,
            path: absPath,
            beforeContent: originalContent,
            afterContent: newContent,
            toolCallId: invocation.toolCallId,
            write: () => writeFile(absPath, newContent, "utf-8"),
        });
        ctx.fileState.recordWrite({
            path: absPath,
            content: newContent,
            observedContent: normalizedNewString,
        });
        const diagnostics = await getPostWriteDiagnostics(absPath, newContent, ctx);

        const result =
            `已修改 ${path}（替换 ${count} 处）${diagnostics}` +
            formatCheckpointWarnings(checkpointWarnings);
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
