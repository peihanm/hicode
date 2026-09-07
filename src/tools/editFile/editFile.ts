import {z} from "zod";
import {readFile} from "node:fs/promises";
import type {Tool, ToolContext} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";
import {findMatches, type MatchSpan} from "./strMatch.js";
import {formatDiff} from "./utils.js";
import {normalizeFileText} from "../shared/fileState.js";
import {createFileChange} from "../../fileChanges/index.js";
import {formatCheckpointWarnings, runTrackedFileWrite,} from "../../checkpoints/index.js";

const editSchema = z.object({
    old_string: z.string().min(1).describe("当前已读版本中要替换的字符串"),
    new_string: z.string().describe("替换后的新内容"),
    replace_all: z.boolean().default(false).describe("替换全部匹配；必须完整读取文件"),
}).strict();

const inputSchema = z.object({
    path: z.string().describe("要修改的文件路径"),
    edits: z.array(editSchema).min(1).max(100).describe("基于同一已读版本的替换列表，范围不得重叠；单处修改也传一项"),
}).strict();

type Edit = z.infer<typeof editSchema>;
interface Replacement extends MatchSpan {
    newString: string;
    editIndex: number;
}
interface EditValidation {
    originalContent: string;
    normalizedContent: string;
    lineEnding: "\n" | "\r\n";
    replacements: Replacement[];
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

async function validateEdits(
    path: string,
    edits: readonly Edit[],
    ctx: ToolContext
): Promise<{ ok: true; value: EditValidation } | { ok: false; message: string }> {
    let originalContent: string;
    try {
        originalContent = await readFile(path, "utf-8");
    } catch (err) {
        return {
            ok: false,
            message: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const state = ctx.fileState.check(path, originalContent);
    if (!state.ok) return {ok: false, message: readStateMessage(path, state.reason)};

    const normalizedContent = normalizeFileText(originalContent);
    const replacements: Replacement[] = [];
    for (const [editIndex, edit] of edits.entries()) {
        const fail = (message: string) => ({ok: false as const, message: `第 ${editIndex + 1} 项: ${message}`});
        const spans = findMatches(normalizedContent, normalizeFileText(edit.old_string));
        if (spans.length === 0) {
            return fail(`在 ${path} 的原版本中找不到 old_string。请确认字符串及上下文，后项不能匹配前项生成的内容。`);
        }
        if (!edit.replace_all && spans.length > 1) {
            return fail(`old_string 在 ${path} 中匹配到 ${spans.length} 处，但 replace_all=false。请提供唯一上下文，或显式传 replace_all=true。`);
        }
        const observed = ctx.fileState.check(path, originalContent, {
            replaceAll: edit.replace_all,
            ranges: spans.map(span => [
                Buffer.byteLength(normalizedContent.slice(0, span.start)),
                Buffer.byteLength(normalizedContent.slice(0, span.end)),
            ] as const),
        });
        if (!observed.ok) return fail(readStateMessage(path, observed.reason));
        const newString = normalizeFileText(edit.new_string);
        for (const span of spans) replacements.push({...span, newString, editIndex});
    }

    replacements.sort((a, b) => a.start - b.start);
    for (let i = 1; i < replacements.length; i++) {
        const previous = replacements[i - 1]!;
        const current = replacements[i]!;
        if (current.start < previous.end) {
            return {ok: false, message: `第 ${previous.editIndex + 1} 项与第 ${current.editIndex + 1} 项的修改范围重叠。请合并为一项明确的替换。`};
        }
    }
    return {
        ok: true,
        value: {
            originalContent,
            normalizedContent,
            lineEnding: originalContent.includes("\r\n") ? "\r\n" : "\n",
            replacements,
        },
    };
}

export const editFileTool: Tool<typeof inputSchema> = {
    name: "edit_file",
    description:
        "精确修改一个文件，单处或多处替换统一使用 edits 数组。" +
        "所有 old_string 均在同一已读原版本中定位，后项不能引用前项生成的文本；范围不得重叠。" +
        "全部匹配校验通过后一次写入，校验失败整次不写。" +
        "部分读取只能修改实际看到的内容；old_string 须唯一匹配，replace_all=true 则须完整读取。" +
        "已确定的同文件多处修改合并为一次调用；需要前一步结果才能决定下一步时分开调用。",
    parameters: inputSchema,
    isReadOnly: () => false,
    getDefaultApprovalScope: ({path}) => ({kind: "workspace", path}),
    async checkPermissions({path, edits}, ctx) {
        const absPath = resolveToolPath(ctx.cwd, path);
        if (ctx.memoryFiles?.classify(absPath)) {
            return {behavior: "allow" as const};
        }

        const preview = edits.slice(0, 8).map((edit, index) =>
            `第 ${index + 1} 项（replace_all=${edit.replace_all}）:\n${formatDiff(edit.old_string, edit.new_string)}`
        ).join("\n");
        const remaining = edits.length > 8 ? `\n另有 ${edits.length - 8} 项，完整输入见工具参数。` : "";
        return {
            behavior: "ask" as const,
            message: `即将修改 ${path}（${edits.length} 项）:\n${preview}${remaining}\n是否执行?`,
        };
    },
    execute: async (
        {path, edits: requestedEdits},
        ctx,
        invocation
    ) => {
        const absPath = resolveToolPath(ctx.cwd, path);
        const validation = await validateEdits(absPath, requestedEdits, ctx);
        if (!validation.ok) {
            return {
                content: `编辑失败: ${validation.message} 本次未写入文件。请按失败位置重新 read_file 核对后再修改。`,
                outcome: "failed" as const,
            };
        }

        const {
            originalContent,
            normalizedContent,
            lineEnding,
            replacements,
        } = validation.value;
        const count = replacements.length;

        let normalizedNewContent = normalizedContent;
        for (const span of [...replacements].reverse()) {
            normalizedNewContent = normalizedNewContent.slice(0, span.start) +
                span.newString + normalizedNewContent.slice(span.end);
        }
        const newContent = restoreLineEndings(normalizedNewContent, lineEnding);
        const edits = replacements.map(span => ({start: Buffer.byteLength(normalizedContent.slice(0, span.start)),
            end: Buffer.byteLength(normalizedContent.slice(0, span.end)), insertedBytes: Buffer.byteLength(span.newString)}));

        if (ctx.memoryFiles?.classify(absPath)) {
            ctx.memoryFiles.validateWrite(absPath, newContent);
        }

        if (newContent === originalContent) {
            return `无需修改 ${path}（内容未发生变化）`;
        }

        if (ctx.memoryFiles?.classify(absPath)) {
            await ctx.memoryFiles.write(absPath, newContent, originalContent, invocation.toolCallId);
            ctx.fileState.forget(absPath);
            return `Memory note 已记录，立即参与召回，待整理: ${path}。后续修改前重新读取规范化 note。`;
        }

        const change = createFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: "update",
            oldContent: originalContent,
            newContent,
            replacements: count,
        });

        const {warnings: checkpointWarnings, identity} = await runTrackedFileWrite({
            runtime: ctx.fileCheckpoints,
            coordinator: ctx.fileCommits,
            signal: ctx.signal,
            path: absPath,
            beforeContent: originalContent,
            afterContent: newContent,
            toolCallId: invocation.toolCallId,
        });
        ctx.fileState.recordWrite({
            identity,
            path: absPath,
            content: newContent,
            beforeContent: originalContent,
            edits,
        });
        const result =
            `已修改 ${path}（替换 ${count} 处）` +
            formatCheckpointWarnings(checkpointWarnings);
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
