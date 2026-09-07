import {readFileSnapshot} from "../shared/fileSnapshot.js";
import {z} from "zod";
import {createByteFileChange} from "../../fileChanges/index.js";
import {formatCheckpointWarnings, runTrackedFileWrite,} from "../../checkpoints/index.js";
import type {Tool} from "../types.js";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";

const inputSchema = z.object({
    path: z.string().describe("要删除的文件路径。删除前必须先用 read_file 确认目标当前版本。"),
});

type Input = z.infer<typeof inputSchema>;

function readRequirement(path: string, reason: "not_read" | "partial_read" | "stale"): string {
    if (reason === "stale") return `文件 ${path} 自上次 read_file 后已被修改，必须重新读取。`;
    return `删除 ${path} 前必须先用 read_file 确认目标当前版本。`;
}

export const deleteFileTool: Tool<typeof inputSchema> = {
    name: "delete_file",
    description: "删除普通文件。删除前必须读取并确认目标版本（支持二进制资产）；项目文件进入权限和 Checkpoint，Memory 主题通过受管 Memory 边界删除。",
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
                : {behavior: "deny" as const, message: "MEMORY.md 是固定入口，不能删除"};
        }
        return {behavior: "ask" as const, message: `即将删除文件: ${path}\n是否执行?`};
    },

    async execute({path}: Input, ctx, invocation) {
        const absPath = resolveToolPath(ctx.cwd, path);
        const snapshot = await readFileSnapshot(absPath);
        const state = ctx.fileState.check(absPath, snapshot.content, {identity: ctx.memoryFiles?.classify(absPath) ? undefined : snapshot.identity, requireFullRead: Boolean(ctx.memoryFiles?.classify(absPath))});
        if (!state.ok) return {content: `删除取消: ${readRequirement(path, state.reason)}`, outcome: "failed" as const};

        const memoryPath = ctx.memoryFiles?.classify(absPath);
        if (memoryPath) {
            if (memoryPath.kind === "index") return {content: "删除取消: MEMORY.md 不能删除", outcome: "failed" as const};
            await ctx.memoryFiles!.delete(absPath, snapshot.content.toString("utf8"));
            ctx.fileState.forget(absPath);
            return `Memory 内容已撤销: ${path}`;
        }

        const change = createByteFileChange({
            path: displayToolPath(ctx.cwd, absPath),
            kind: "delete",
            oldContent: snapshot.content,
            newContent: Buffer.alloc(0),
        });
        const {warnings} = await runTrackedFileWrite({
            runtime: ctx.fileCheckpoints,
            coordinator: ctx.fileCommits,
            signal: ctx.signal,
            path: absPath,
            beforeContent: snapshot.content,
            afterContent: null,
            toolCallId: invocation.toolCallId,
        });
        ctx.fileState.forget(absPath);
        const result = `已删除 ${path}${formatCheckpointWarnings(warnings)}`;
        return {
            content: result,
            displayContent: result,
            uiData: {type: "file_change", change},
        };
    },
};
