import {z} from "zod";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

// TodoWrite 工具：agent 用全量替换更新任务清单
// 参考 claude-code src/tools/TodoWriteTool/TodoWriteTool.ts
//
// 关键设计：全量替换，不是增量。每次调用传完整 todos 数组。
//
// checkPermissions 直接 allow：todo 操作无副作用，只是更新 UI state。
// setTodos 通过 ToolContext 注入，避免工具耦合 React。

const todoSchema = z.object({
    content: z.string().describe("任务描述（祈使句，如 'Fix the auth bug'）"),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string().describe(
        "进行时描述（如 'Fixing the auth bug'），spinner 显示用"
    ),
});

const inputSchema = z.object({
    todos: z.array(todoSchema).describe("完整任务清单（全量替换，不是增量）"),
});

type Input = z.infer<typeof inputSchema>;

export const todoWriteTool: Tool<typeof inputSchema> = {
    name: "todo_write",
    description: [
        "更新任务清单。每次调用传完整 todos 数组（全量替换）。",
        "",
        "使用场景：",
        "1. 复杂多步任务（3+ 步骤）— 拆解 + 追踪进度",
        "2. 用户给了多个任务 — 立即捕获为 todos",
        "3. 开始任务前 — 标记 in_progress（同时只能有一个 in_progress）",
        "4. 阶段切换前 — 在一次更新中将已完成项标记 completed、下一项标记 in_progress，再开始下一项工作；不要到最终回复前集中补记。",
        "例如：项目骨架已完成、接下来实现核心逻辑 → 先更新骨架 completed、核心逻辑 in_progress（保留其余项）→ 再写核心逻辑。",
        "正文中的进度说明不能替代工具更新。同一项仍在处理中时无需重复更新；范围改变时调整或移除不再相关的项。发现漏更新时按真实进度纠正，不要伪造完成。",
        "",
        "不要在单步任务或纯信息查询时使用。",
    ].join("\n"),
    parameters: inputSchema,

    isReadOnly: () => true,

    async checkPermissions(): Promise<PermissionResult> {
        // todo 操作无副作用，直接放行
        return {behavior: "allow"};
    },

    async execute({todos}: Input, ctx: ToolContext): Promise<string> {
        // 全部完成时清空 todos（跟 claude-code TodoWriteTool.ts:69 一致）
        // 避免"全部 ✓ 还显示在屏幕上"，任务完成后列表自动消失
        const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
        await ctx.setTodos(allDone ? [] : todos);
        return allDone
            ? "所有任务已完成，清单已清空。"
            : "Todos 已更新。开始下一项工作前，先同步已完成项和下一进行项。";
    },
};
