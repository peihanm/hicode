import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";

const server = new McpServer({
    name: "hicode-collaboration-tools",
    version: "1.0.0",
});
const categories = [
    {name: "slack", description: "Search Slack channels, threads and team messages"},
    {name: "drive", description: "Search shared Drive files, folders and documents"},
    {name: "jira", description: "Search Jira projects, tickets and sprint status"},
];

for (let index = 0; index < 60; index++) {
    const category = categories[index % categories.length]!;
    const name = `${category.name}_${String(index).padStart(3, "0")}`;
    server.registerTool(name, {
        description: `${category.description}. Deterministic fixture tool ${index}.`,
        inputSchema: {
            query: z.string().describe("Search query"),
            limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: {readOnlyHint: true, destructiveHint: false},
    }, async ({query, limit}) => ({
        content: [{
            type: "text",
            text: JSON.stringify({tool: name, query, limit: limit ?? null}),
        }],
    }));
}

await server.connect(new StdioServerTransport());
