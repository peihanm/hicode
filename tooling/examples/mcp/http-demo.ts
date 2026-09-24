#!/usr/bin/env bun
import {setTimeout as delay} from "node:timers/promises";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {isInitializeRequest} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";

async function main(): Promise<void> {
    const port = Number(process.argv[2] ?? "8787");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Usage: bun http-demo.ts [port: 1–65535]");
    const origin = `http://127.0.0.1:${port}`;
    const shutdown = new AbortController();
    const sessions = new Map<string, {server: McpServer; transport: WebStandardStreamableHTTPServerTransport}>();
    const annotations = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
    const result = (tool: string, data: Record<string, unknown>) => {
        const requestId = crypto.randomUUID();
        console.log(`[${new Date().toISOString()}] ${tool} completed · ${requestId}`);
        return {content: [{type: "text" as const, text: JSON.stringify({tool, requestId, ...data})}]};
    };

    const listener = Bun.serve({
        hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: 64 * 1024,
        async fetch(request) {
            if (shutdown.signal.aborted) return new Response("Shutting down", {status: 503});
            const url = new URL(request.url);
            const requestOrigin = request.headers.get("origin");
            if (request.headers.get("host") !== `127.0.0.1:${port}` || (requestOrigin && requestOrigin !== origin)) {
                return new Response("Invalid host or origin", {status: 403});
            }
            if (url.pathname === "/health" && request.method === "GET") {
                return Response.json({status: "ok", tools: ["hello", "add", "wait"], sessions: sessions.size});
            }
            if (url.pathname !== "/mcp") return new Response("Not found", {status: 404});
            const sessionId = request.headers.get("mcp-session-id");
            if (sessionId) {
                const session = sessions.get(sessionId);
                return session ? session.transport.handleRequest(request) : new Response("Unknown session", {status: 404});
            }
            if (request.method !== "POST") return new Response("Initialize with POST first", {status: 405});
            let body: unknown;
            try {body = await request.json();} catch {return new Response("Invalid JSON", {status: 400});}
            if (!isInitializeRequest(body)) return new Response("Initialize first", {status: 400});
            if (sessions.size >= 32) return new Response("Too many sessions; restart this demo server", {status: 503});

            const id = crypto.randomUUID();
            const server = new McpServer({name: "hicode-http-demo", version: "1.0.0"});
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => id,
                onsessioninitialized: () => {console.log(`Session connected · ${id}`);},
                onsessionclosed: () => {console.log(`Session closed · ${id}`);},
            });
            server.registerTool("hello", {
                description: "Return a greeting and a fresh server request ID to verify a real HTTP MCP call.",
                inputSchema: {name: z.string().min(1).max(100)}, annotations,
            }, ({name}) => result("hello", {greeting: `Hello, ${name}! This response came from the local HTTP MCP server.`}));
            server.registerTool("add", {
                description: "Add two finite numbers on the HTTP MCP server.",
                inputSchema: {a: z.number().finite(), b: z.number().finite()}, annotations,
            }, ({a, b}) => {
                const sum = a + b;
                if (!Number.isFinite(sum)) throw new Error("Result is outside the supported numeric range");
                return result("add", {a, b, sum});
            });
            server.registerTool("wait", {
                description: "Wait for 1–60 seconds, then return a message. Supports cancellation for testing Escape.",
                inputSchema: {seconds: z.number().int().min(1).max(60), message: z.string().max(200)}, annotations,
            }, async ({seconds, message}, extra) => {
                console.log(`wait started · ${seconds}s`);
                try {
                    await delay(seconds * 1000, undefined, {signal: AbortSignal.any([extra.signal, shutdown.signal])});
                    return result("wait", {seconds, message});
                } catch (error) {console.log("wait cancelled"); throw error;}
            });
            sessions.set(id, {server, transport});
            server.server.onclose = () => {sessions.delete(id);};
            try {
                await server.connect(transport);
                return await transport.handleRequest(request, {parsedBody: body});
            } catch {
                sessions.delete(id);
                await server.close();
                return new Response("MCP session initialization failed", {status: 500});
            }
        },
    });

    const stop = async () => {
        if (shutdown.signal.aborted) return;
        shutdown.abort();
        await Promise.allSettled([...sessions.values()].map(session => session.server.close()));
        await listener.stop(true);
        console.log("HTTP MCP demo stopped");
    };
    process.once("SIGINT", () => {void stop();});
    process.once("SIGTERM", () => {void stop();});
    console.log(`HTTP MCP demo ready: ${origin}/mcp`);
    console.log(`Health check: ${origin}/health`);
    console.log("Tools: hello, add, wait · Stop with Ctrl+C");
}

await main();
