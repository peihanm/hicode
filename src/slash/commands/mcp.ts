import type {SlashCommand} from "../types.js";

export const mcpCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "mcp",
    description: "显示 MCP Server 连接状态",
    async execute(args, context) {
        if (args.startsWith("reconnect ")) {
            try {
                const manager = context.ctx.mcpManager;
                if (!manager) throw new Error("没有配置 MCP Server");
                await manager.reconnect(args.slice("reconnect ".length).trim());
            } catch (error) {
                await context.onEvent({type: "assistant_text", content: `MCP 重连失败：${error instanceof Error ? error.message : String(error)}`});
                return;
            }
        } else if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法：/mcp 或 /mcp reconnect <server-name>",
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
