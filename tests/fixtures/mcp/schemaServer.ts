import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({name: "schema-fixture", version: "1"}, {capabilities: {tools: {}}});
let calls = 0;
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [
    {name: "validated", description: "Validate before sending", inputSchema: {type: "object", properties: {payload: {type: "object", properties: {count: {type: "integer", minimum: 1}, mode: {enum: ["safe"]}}, required: ["count", "mode"], additionalProperties: false}}, required: ["payload"], additionalProperties: false}},
    {name: "stats", description: "Remote invocation counter", inputSchema: {type: "object"}, annotations: {readOnlyHint: true}},
    {name: "invalid_schema", inputSchema: {type: "object", properties: {x: {type: "string", unknownAssertion: true}}}},
]}));
// Deliberately no application-level validation: every remote call is observable.
server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === "stats") return {content: [{type: "text", text: `calls:${calls}`}]};
    calls++;
    return {content: [{type: "text", text: JSON.stringify(request.params.arguments)}]};
});
await server.connect(new StdioServerTransport());
