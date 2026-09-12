import {formatAgentRegistryReport} from "../../subagents/diagnostics.js";
import type {SlashCommand} from "../types.js";

export const agentsCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "agents",
    description: "Create, manage or reload Agents",
    argumentHint: "[reload]",
    async execute(args, context) {
        if (args === "reload") {
            const catalog = context.subagents;
            if (!("reload" in catalog) || typeof catalog.reload !== "function") {
                await context.onEvent({
                    type: "assistant_text",
                    content: "This entry point does not support Agent hot reload.",
                });
                return;
            }
            const result = await catalog.reload();
            await context.onEvent({
                type: "assistant_text",
                content: [
                    `Agents Reload · revision ${result.revision}`,
                    `Added ${result.added.length} · updated ${result.updated.length} · removed ${result.removed.length} · loading issues ${result.issues.length}`,
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
                content: "Usage: /agents or /agents reload",
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
