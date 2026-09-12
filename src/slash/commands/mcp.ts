import type {SlashCommand} from "../types.js";

export const mcpCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "mcp",
    description: "Show MCP Server connection status",
    async execute(args, context) {
        if (args.startsWith("reconnect ")) {
            try {
                const manager = context.ctx.mcpManager;
                if (!manager) throw new Error("No MCP Servers configured");
                await manager.reconnect(args.slice("reconnect ".length).trim());
            } catch (error) {
                await context.onEvent({type: "assistant_text", content: `MCP reconnection failed: ${error instanceof Error ? error.message : String(error)}`});
                return;
            }
        } else if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "Usage: /mcp or /mcp reconnect <server-name>",
            });
            return;
        }
        const snapshots = context.ctx.mcpManager?.getSnapshots() ?? [];
        const content = snapshots.length === 0
            ? "No MCP Servers configured."
            : snapshots.map((item) => {
                const tools = `${item.toolCount} tool${item.toolCount === 1 ? "" : "s"}`;
                const error = item.error ? ` — ${item.error.replace(/\s+/g, " ").slice(0, 240)}` : "";
                return `${item.name}  ${item.status}  ${tools}  ${item.source}${error}`;
            }).join("\n");
        await context.onEvent({type: "assistant_text", content});
    },
};
