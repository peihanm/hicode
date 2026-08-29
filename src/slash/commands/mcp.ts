import type {SlashCommand} from "../types.js";

export const mcpCommand: SlashCommand = {
    busyBehavior: "immediate",
    name: "mcp",
    description: "显示 MCP Server 连接状态",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "/mcp 暂不接受参数；修改 MCP 配置后请重启 Pillar。",
            });
            return;
        }
        const snapshots = context.ctx.mcpManager?.getSnapshots() ?? [];
        const content = snapshots.length === 0
            ? "没有配置 MCP Server。"
            : snapshots.map((item) => {
                const tools = `${item.toolCount} tool${item.toolCount === 1 ? "" : "s"}`;
                const error = item.error ? ` — ${item.error.replace(/\s+/g, " ").slice(0, 240)}` : "";
                return `${item.name}  ${item.status}  ${tools}  ${item.source}${error}`;
            }).join("\n");
        await context.onEvent({type: "assistant_text", content});
    },
};
