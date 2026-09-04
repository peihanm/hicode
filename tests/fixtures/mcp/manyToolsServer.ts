import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";

const server = new McpServer({name: "pillar-many-tools", version: "1.0.0"});
const categories = [
    {name: "browser", description: "Navigate pages, inspect DOM and capture screenshots"},
    {name: "github", description: "Search repositories, issues and pull requests"},
    {name: "calendar", description: "Find meetings, attendees and available time slots"},
    {name: "documents", description: "Search documents and knowledge base pages"},
    {name: "database", description: "Inspect schemas, query records and aggregate metrics"},
];

for (let index = 0; index < 100; index++) {
    const category = categories[index % categories.length]!;
    const name = `${category.name}_${String(index).padStart(3, "0")}`;
    server.registerTool(name, {
        description: `${category.description}. Deterministic fixture tool ${index}.`,
        inputSchema: {
            query: z.string().optional().describe("Query or target identifier"),
            limit: z.number().int().min(1).max(100).optional(),
        },
        annotations: {readOnlyHint: true, destructiveHint: false},
    }, async ({query, limit}) => ({
        content: [{
            type: "text",
            text: JSON.stringify({tool: name, query: query ?? null, limit: limit ?? null}),
        }],
    }));
}

await server.connect(new StdioServerTransport());
