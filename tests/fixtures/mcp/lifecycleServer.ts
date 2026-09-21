import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({name: "lifecycle-fixture", version: "1"}, {capabilities: {tools: {listChanged: true}}});
let mode = "initial";
let lists = 0;
const tool = (name: string) => ({name, inputSchema: {type: "object" as const, properties: {action: {type: "string"}}},
    annotations: {readOnlyHint: true}});
server.setRequestHandler(ListToolsRequestSchema, async () => {
    lists++;
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 200));
    if (mode === "storm") await server.notification({method: "notifications/tools/list_changed"});
    const tools = [tool("control"), tool(["initial", "same", "slow", "changed"].includes(mode) ? "old" : "new")];
    if (mode === "changed") tools[1] = {...tool("old"), annotations: {readOnlyHint: false}};
    if (mode === "invalid") tools.push({name: "bad", inputSchema: {type: "object", properties: {action: {type: "not-a-type"}}}, annotations: {readOnlyHint: true}});
    return {tools};
});
server.setRequestHandler(CallToolRequestSchema, async request => {
    const action = request.params.arguments?.action;
    if (request.params.name === "control" && typeof action === "string") {
        if (action === "disconnect") setTimeout(() => {void server.close();}, 10);
        else if (["refresh", "invalid", "storm", "same", "slow", "changed"].includes(action)) {
            mode = action;
            setTimeout(() => {void server.notification({method: "notifications/tools/list_changed"});}, 10);
        }
    }
    return {content: [{type: "text", text: JSON.stringify({pid: process.pid, mode, lists})}]};
});
await server.connect(new StdioServerTransport());
