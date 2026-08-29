import {formatAgentRegistryReport} from "../../subagents/diagnostics.js";
import type {SlashCommand} from "../types.js";

export const agentsCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "agents",
    description: "创建、管理或重新加载 Agent",
    argumentHint: "[reload]",
    async execute(args, context) {
        if (args === "reload") {
            const catalog = context.subagents;
            if (!("reload" in catalog) || typeof catalog.reload !== "function") {
                await context.onEvent({
                    type: "assistant_text",
                    content: "当前运行入口不支持 Agent 热重载。",
                });
                return;
            }
            const result = await catalog.reload();
            await context.onEvent({
                type: "assistant_text",
                content: [
                    `Agents Reload · revision ${result.revision}`,
                    `新增 ${result.added.length} · 更新 ${result.updated.length} · 移除 ${result.removed.length} · 加载问题 ${result.issues.length}`,
                    formatAgentRegistryReport(
                        context.subagents,
                        context.ctx.fastModel
                    ),
                ].join("\n\n"),
            });
            return;
        }
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法：/agents 或 /agents reload",
            });
            return;
        }
        if (context.openAgents) {
            context.openAgents();
            return;
        }
        await context.onEvent({
            type: "assistant_text",
            content: formatAgentRegistryReport(
                context.subagents,
                context.ctx.fastModel
            ),
        });
    },
};
