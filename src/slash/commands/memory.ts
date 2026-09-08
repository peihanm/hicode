import {MEMORY_TYPES, type MemoryType} from "../../memory/index.js";
import type {SlashCommand} from "../types.js";

function isMemoryType(value: string): value is MemoryType {
    return (MEMORY_TYPES as readonly string[]).includes(value);
}

export const memoryCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "memory",
    description: "查看和维护跨 Session 的持久 Memory",
    argumentHint: "[list [type] | show <key> | forget <key> | maintain]",
    async execute(args, context) {
        const memory = context.memory;
        if (!memory) {
            await context.onEvent({
                type: "assistant_text",
                content: "当前 Runtime 没有 Memory 能力。",
            });
            return;
        }
        const [action = "status", value, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (rest.length > 0) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法: /memory [list [type] | show <key> | forget <key> | maintain]",
            });
            return;
        }

        if (action === "status") {
            const status = await memory.status();
            const lines = [
                `Memory: ${status.enabled ? "enabled" : "disabled"}`,
                `Auto extract: ${status.autoExtract ? "enabled" : "disabled"}`,
                `Directory: ${status.directory}`,
                `Entries: user ${status.counts.user} · feedback ${status.counts.feedback} · project ${status.counts.project} · reference ${status.counts.reference}`,
                `Pending notes: ${status.pending} · Published topics: ${status.published} · Maintaining: ${status.maintaining ? "yes" : "no"}`,
            ];
            if (status.issues.length > 0) {
                lines.push(
                    "Issues:",
                    ...status.issues.slice(-10).map((issue) =>
                        `- ${issue.path}: ${issue.message}`
                    )
                );
            }
            if (!status.enabled) {
                lines.push("可在 Settings 中配置 memory.enabled。修改后请重启 Pillar。");
            }
            await context.onEvent({type: "assistant_text", content: lines.join("\n")});
            return;
        }

        if (!memory.enabled) {
            await context.onEvent({
                type: "assistant_text",
                content: "Memory 已关闭。请在 Settings 中启用后重启 Pillar。",
            });
            return;
        }

        if (action === "list") {
            if (value && !isMemoryType(value)) {
                await context.onEvent({
                    type: "assistant_text",
                    content: `未知 Memory 类型: ${value}。可选: ${MEMORY_TYPES.join(", ")}`,
                });
                return;
            }
            const scan = await memory.list();
            const entries = value
                ? scan.entries.filter((entry) => entry.type === value)
                : scan.entries;
            const lines = entries.map((entry) =>
                `- ${entry.key} [${entry.type}] ${entry.name} — ${entry.description}`
            );
            await context.onEvent({
                type: "assistant_text",
                content: lines.length > 0 ? lines.join("\n") : "没有持久 Memory。",
            });
            return;
        }

        if (action === "show") {
            if (!value) {
                await context.onEvent({type: "assistant_text", content: "用法: /memory show <key>"});
                return;
            }
            const entry = await memory.read(value);
            await context.onEvent({
                type: "assistant_text",
                content: entry
                    ? `# ${entry.name}\n\n${entry.description}\n\n${entry.content}\n\n来源: ${JSON.stringify(entry.evidence)}\n\nPath: ${entry.path}`
                    : `Memory 不存在: ${value}`,
            });
            return;
        }

        if (action === "forget") {
            if (!value) {
                await context.onEvent({type: "assistant_text", content: "用法: /memory forget <key>"});
                return;
            }
            if (context.ctx.permissionMode === "readOnly" || context.ctx.collaborationMode === "plan") {
                await context.onEvent({type: "assistant_text", content: "当前只读/Plan 模式不能删除 Memory。"}); return;
            }
            const change = await memory.forget(value, context.ctx.signal);
            if (change) {
                await context.onEvent({
                    type: "memory_update",
                    source: "explicit",
                    changes: [change],
                });
                await context.onEvent({
                    type: "assistant_text",
                    content: `Memory 已忘记: ${change.key}`,
                });
            } else {
                await context.onEvent({
                    type: "assistant_text",
                    content: `Memory 不存在: ${value}`,
                });
            }
            return;
        }

        if (action === "maintain") {
            if (context.ctx.permissionMode === "readOnly" || context.ctx.collaborationMode === "plan") {
                await context.onEvent({type: "assistant_text", content: "当前只读/Plan 模式不能整理 Memory。"}); return;
            }
            if(!context.ctx.tasks) {await context.onEvent({type:"assistant_text",content:"当前 Runtime 未提供 Memory 维护任务能力。"});return;}
            const task=await context.ctx.tasks.startMemory({turnId:context.ctx.turnId,signal:context.ctx.signal,background:false});
            await context.onEvent({type:"assistant_text",content:task?task.resultPreview??task.outputIssue??`Memory 任务 ${task.status}`:"没有待处理来源或当前已在整理；未启动新的模型调用。"});
            return;
        }

        await context.onEvent({
            type: "assistant_text",
            content: "用法: /memory [list [type] | show <key> | forget <key> | maintain]",
        });
    },
};
