import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {createMcpManager} from "../../src/mcp/manager.js";
import {connectMcpServer} from "../../src/mcp/client.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createTestContext} from "../helpers/testContext.js";
import type {McpApprovalRequest} from "../../src/mcp/types.js";

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("HTTP fixture transition timed out");
        await Bun.sleep(5);
    }
}

test("HTTP oversized startup response is cancelled before JSON parsing with a useful diagnostic", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: async request => {
        if (request.method !== "POST") return new Response(null, {status: 405});
        const message = await request.json() as {id?: number; method: string; params?: {protocolVersion: string}};
        if (message.id === undefined) return new Response(null, {status: 202});
        if (message.method === "initialize") return Response.json({jsonrpc: "2.0", id: message.id,
            result: {protocolVersion: message.params!.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: "limit", version: "1"}}});
        let sent = 0;
        return new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
                await Bun.sleep(1);
                if (cancelled) return;
                if (sent++ >= 130) {controller.close(); return;}
                controller.enqueue(chunk);
            }, cancel() {cancelled = true;},
        }), {headers: {"content-type": "application/json"}});
    }});
    try {
        await withTempProject(async cwd => {
            await expect(connectMcpServer({name: "limit", source: "host", id: "limit", config: {
                type: "http", url: `http://127.0.0.1:${server.port}/mcp`, disabled: false, timeoutMs: 5000, toolTimeoutMs: 5000,
            }}, cwd, testChildEnvironment)).rejects.toThrow("128 MiB transport limit");
            await until(() => cancelled);
        });
    } finally {await server.stop(true);}
}, 10000);

async function httpFixture(json: boolean) {
    const protocol = new Server({name: "http-fixture", version: "1"}, {capabilities: {tools: {listChanged: true}}});
    const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: json});
    const requests: Array<{method: string; session: string | null}> = [];
    let version = 1, calls = 0, cancellations = 0;
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{
        name: "echo", description: `revision ${version}`, inputSchema: {type: "object", properties: {wait: {type: "boolean"}}},
        annotations: {readOnlyHint: true},
    }]}));
    protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        calls++;
        if (request.params.arguments?.wait) await new Promise<void>(resolve => {
            const cancel = () => {cancellations++; resolve();};
            if (extra.signal.aborted) cancel();
            else extra.signal.addEventListener("abort", cancel, {once: true});
        });
        return {content: [{type: "text", text: "HTTP fixture result"}]};
    });
    await protocol.connect(transport);
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: request => {
        requests.push({method: request.method, session: request.headers.get("mcp-session-id")});
        return transport.handleRequest(request);
    }});
    return {
        url: `http://127.0.0.1:${server.port}/mcp`, requests,
        get calls() {return calls;}, get cancellations() {return cancellations;},
        async refresh() {version++; await protocol.notification({method: "notifications/tools/list_changed"});},
        disconnectNotifications() {transport.closeStandaloneSSEStream();},
        async close() {await protocol.close(); await server.stop(true);},
    };
}

test("HTTP SSE survives Bun's socket idle deadline in an isolated client", async () => {
    const fixture = await httpFixture(true);
    try {
        await withTempProject(async cwd => {
            const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../fixtures/mcp/httpIdleClient.ts"), cwd, fixture.url], {
                env: {PATH: process.env.PATH, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1", NO_PROXY: "127.0.0.1"},
                stdout: "pipe", stderr: "pipe",
            });
            const deadline = setTimeout(() => child.kill(), 10000);
            try {
                const [code, stdout, stderr] = await Promise.all([
                    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
                ]);
                expect(stderr).toBe("");
                expect(code).toBe(0);
                expect(stdout).toContain("IDLE_CONNECTION_OK");
                expect(fixture.requests.some(request => request.method === "GET")).toBe(true);
                expect(fixture.requests.some(request => request.method === "DELETE")).toBe(true);
            } finally {clearTimeout(deadline); child.kill(); await child.exited;}
        });
    } finally {await fixture.close();}
}, 15000);

test.each([true, false])("HTTP MCP JSON=%s approval, session, discovery, calls and notifications", async json => {
    const fixture = await httpFixture(json);
    try {
        await withTempProject(async (cwd, storage) => {
            await writeFile(join(cwd, ".mcp.json"), JSON.stringify({mcpServers: {remote: {url: fixture.url}}}));
            let approval: McpApprovalRequest | undefined;
            const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment,
                requestApproval: async request => {
                    expect(fixture.requests).toHaveLength(0);
                    approval = request;
                    return "enable";
                }});
            try {
                await manager.initialize();
                expect(approval).toMatchObject({type: "http", url: fixture.url});
                expect(manager.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 1});
                const runtime = createToolRuntime({getAdditionalTools: () => manager.getTools()});
                const ctx = createTestContext(cwd, {mcpManager: manager});
                runtime.getToolSchemas();
                await runtime.executeTool("tool_search", '{"names":["mcp__remote__echo"]}', ctx, "discover");
                runtime.getToolSchemas();
                const result = await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__remote__echo", arguments: {}}), ctx, "call");
                expect(result.outcome).toBe("ok");
                expect(JSON.stringify(result)).toContain("HTTP fixture result");
                const prior = manager.getTools()[0];
                await until(() => fixture.requests.some(request => request.method === "GET"));
                await fixture.refresh();
                await until(() => manager.getSnapshots()[0]?.catalog?.revision === 2);
                expect(manager.getTools()[0]).not.toBe(prior);
                expect(manager.getSnapshots()[0]?.catalog?.changed).toEqual(["mcp__remote__echo"]);
                expect(fixture.requests.slice(1).every(request => request.session)).toBe(true);
            } finally {await manager.closeAll();}
            expect(fixture.requests.some(request => request.method === "DELETE")).toBe(true);
            expect(manager.getTools()).toEqual([]);
            await manager.closeAll();
        });
    } finally {await fixture.close();}
});

test.each(["cancel", "timeout", "shutdown"])("HTTP pending tool %s settles and cancels the remote request", async action => {
    const fixture = await httpFixture(false);
    try {
        await withTempProject(async (cwd, storage) => {
            const controller = new AbortController();
            const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment,
                hostServers: [{name: "remote", url: fixture.url, toolTimeoutMs: 1000}], requestApproval: async () => "enable"});
            try {
                await manager.initialize();
                const runtime = createToolRuntime({getAdditionalTools: () => manager.getTools()});
                const ctx = createTestContext(cwd, {signal: controller.signal, mcpManager: manager});
                runtime.getToolSchemas();
                await runtime.executeTool("tool_search", '{"names":["mcp__remote__echo"]}', ctx, "discover");
                runtime.getToolSchemas();
                const pending = runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__remote__echo", arguments: {"wait":true}}), ctx, "pending");
                await until(() => fixture.calls === 1);
                if (action === "cancel") controller.abort();
                if (action === "shutdown") await manager.closeAll();
                expect((await pending).outcome).not.toBe("ok");
                if (action !== "shutdown") {
                    await until(() => fixture.cancellations === 1);
                    expect(manager.getSnapshots()[0]?.status).toBe("connected");
                    expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__remote__echo", arguments: {}}), createTestContext(cwd, {mcpManager: manager}), "after-cancel")).outcome).toBe("ok");
                }
            } finally {await manager.closeAll();}
        });
    } finally {await fixture.close();}
});

test("HTTP notification stream outlives startup timeout and disconnect revokes tools", async () => {
    const fixture = await httpFixture(true);
    try {
        await withTempProject(async (cwd, storage) => {
            const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment,
                hostServers: [{name: "remote", url: fixture.url, timeoutMs: 1000}], requestApproval: async () => "enable"});
            try {
                await manager.initialize();
                await Bun.sleep(1100);
                await fixture.refresh();
                await until(() => manager.getSnapshots()[0]?.catalog?.revision === 2);
                fixture.disconnectNotifications();
                await until(() => manager.getSnapshots()[0]?.status === "failed");
                expect(manager.getTools()).toEqual([]);
            } finally {await manager.closeAll();}
        });
    } finally {await fixture.close();}
});

test("HTTP skip sends no traffic and approval hides query values", async () => {
    const fixture = await httpFixture(true);
    try {
        await withTempProject(async (cwd, storage) => {
            const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment,
                hostServers: [{name: "remote", url: `${fixture.url}?key=private-value`}], requestApproval: async request => {
                    expect(JSON.stringify(request)).not.toContain("private-value");
                    expect(request).toMatchObject({type: "http"});
                    return "cancel";
                }});
            try {
                await manager.initialize();
                expect(manager.getSnapshots()[0]?.status).toBe("pending-approval");
                expect(fixture.requests).toEqual([]);
            } finally {await manager.closeAll();}
        });
    } finally {await fixture.close();}
});

test.each([401, 500, 302])("HTTP %s does not expose response bodies or follow redirects", async status => {
    let forwarded = 0;
    const destination = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => {forwarded++; return new Response("unexpected");}});
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("private-response-secret", {
        status, headers: {location: `http://127.0.0.1:${destination.port}/other?key=private-query-secret`},
    })});
    try {
        await withTempProject(async (cwd, storage) => {
            const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment,
                hostServers: [{name: "remote", url: `http://127.0.0.1:${server.port}/mcp?key=private-query-secret`}],
                requestApproval: async () => "enable"});
            try {
                await manager.initialize();
                expect(manager.getSnapshots()[0]?.status).toBe("failed");
                expect(JSON.stringify(manager.getSnapshots())).not.toContain("private-");
                expect(forwarded).toBe(0);
                expect(manager.getTools()).toEqual([]);
            } finally {await manager.closeAll();}
        });
    } finally {await server.stop(true); await destination.stop(true);}
});

test("HTTP initialization timeout also aborts the pending network request", async () => {
    let requests = 0;
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async request => {
        requests++;
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), {once: true}));
        return new Response(null, {status: 204});
    }});
    try {
        await withTempProject(async (cwd, storage) => {
            const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment,
                hostServers: [{name: "remote", url: `http://127.0.0.1:${server.port}/mcp`, timeoutMs: 1000}],
                requestApproval: async () => "enable"});
            const start = Date.now();
            try {
                await manager.initialize();
                expect(manager.getSnapshots()[0]?.status).toBe("failed");
                expect(requests).toBe(1);
                expect(Date.now() - start).toBeLessThan(3000);
            } finally {await manager.closeAll();}
        });
    } finally {await server.stop(true);}
});
