import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";

const [pidFile, mode] = process.argv.slice(2);
if (!pidFile) throw new Error("Missing pid file");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
child.unref();
writeFileSync(pidFile, JSON.stringify({parent: process.pid, child: child.pid}));
const server = new Server({name: "process-tree", version: "1"}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, () => {
    if (mode === "startup-failure") throw new Error("Fixture initialization failed");
    return {tools: [{name: "exit", inputSchema: {type: "object"}}]};
});
server.setRequestHandler(CallToolRequestSchema, (_request, extra) => {
    if (mode === "final-response") {
        process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: extra.requestId,
            result: {content: [{type: "text", text: "x".repeat(1024 * 1024) + "FINAL_RESPONSE"}]}}) + "\n", () => process.exit(0));
        return new Promise<never>(() => {});
    }
    setTimeout(() => process.exit(0), 20);
    return {content: [{type: "text", text: "exiting"}]};
});
if (mode !== "stubborn") process.stdin.on("end", () => process.exit(0));
else {process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);}
await server.connect(new StdioServerTransport());
