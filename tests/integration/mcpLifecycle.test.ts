import {expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {createMcpManager} from "../../src/mcp/manager.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createTestContext} from "../helpers/testContext.js";
import {createMcpApprovalIdentity, getMcpApproval} from "../../src/mcp/approval.js";
import {loadMcpConfig} from "../../src/mcp/config.js";
import type {McpApprovalDecision} from "../../src/mcp/types.js";

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("MCP transition timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test.each(["cancel", "abort"])("授权 %s 不持久拒绝，下一次启动仍询问且批准后才启动进程", async action => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, ".mcp.json"), JSON.stringify({mcpServers: {fixture: {
            command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000,
        }}}));
        const loaded = await loadMcpConfig(storage, cwd, ["project"]);
        const identity = await createMcpApprovalIdentity(cwd, loaded.servers[0]!);
        const controller = new AbortController();
        const initial = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            signal: controller.signal, requestApproval: async () => {
                if (action === "abort") controller.abort();
                return action === "abort" ? "enable" : "cancel";
            }});
        try {
            await initial.initialize();
            expect(initial.getTools()).toHaveLength(0);
            expect(initial.getSnapshots()[0]?.status).toBe("pending-approval");
            expect(await getMcpApproval(join(storage.hicodeHome, "mcp-approvals.json"), identity, "fixture")).toMatchObject({decision: "pending"});
        } finally {await initial.closeAll();}
        let requests = 0;
        const restarted = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            requestApproval: async () => {requests++; return "enable";}});
        try {
            await restarted.initialize();
            expect(requests).toBe(1);
            expect(restarted.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
        } finally {await restarted.closeAll();}
    });
});

test("取消不保存批准，headless 不绕过；启用后重启和重连无需再确认", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, ".mcp.json"), JSON.stringify({mcpServers: {fixture: {
            command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000,
        }}}));
        let decision: McpApprovalDecision = "cancel", requests = 0;
        const make = (headless = false) => createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            headless, requestApproval: async () => {requests++; return decision;}});
        const headless = make(true);
        try {
            await headless.initialize(); await headless.reconnect("fixture");
            expect(headless.getSnapshots()[0]?.status).toBe("pending-approval");
            expect(requests).toBe(0);
        } finally {await headless.closeAll();}
        const manager = make();
        try {
            await manager.initialize();
            expect(requests).toBe(1); expect(manager.getTools()).toHaveLength(0);
            expect(manager.getSnapshots()[0]?.status).toBe("pending-approval");
            decision = "enable";
            await manager.reconnect("fixture");
            expect(requests).toBe(2);
            expect(manager.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
            await manager.reconnect("fixture");
            expect(requests).toBe(2);
        } finally {await manager.closeAll();}
        const restarted = make(true);
        try {
            await restarted.initialize();
            expect(restarted.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
            expect(requests).toBe(2);
        } finally {await restarted.closeAll();}
    });
});

test.each(["refresh", "disconnect", "invalid", "storm"])("真实 stdio 生命周期 %s 撤销旧能力、隔离其他服务、显式重连", async action => {
    await withTempProject(async (cwd, storage) => {
        const path = join(storage.hicodeHome, "mcp.json");
        await mkdir(storage.hicodeHome, {recursive: true});
        const config = {type: "stdio", command: process.execPath,
            args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000};
        await writeFile(path, JSON.stringify({mcpServers: {first: config, second: config}}));
        const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment, headless: true});
        try {
            await manager.initialize();
            const stable = manager.getTools().filter(tool => tool.name.startsWith("mcp__second__"));
            const runtime = createToolRuntime({getAdditionalTools: () => manager.getTools()});
            const frozen = createToolRuntime({additionalTools: manager.getTools()});
            const ctx = createTestContext(cwd);
            const discover = async (target = runtime) => {
                target.getToolSchemas();
                await target.executeTool("tool_search", JSON.stringify({names: ["mcp__first__control","mcp__first__old","mcp__second__old"]}), ctx, "load");
                target.getToolSchemas();
            };
            await discover(); await discover(frozen);
            const result = await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__first__control", arguments: {action}}), ctx, "control");
            expect(result.outcome).toBe("ok");
            await until(() => action === "refresh" ? manager.getTools().some(tool => tool.name === "mcp__first__new") :
                ["failed", "closed"].includes(manager.getSnapshots()[0]?.status ?? ""));
            expect(runtime.toolNames).not.toContain("mcp__first__old");
            expect(runtime.getToolSchemas().map(tool => tool.function.name)).not.toContain("mcp__first__old");
            expect((await frozen.executeTool("mcp_call", JSON.stringify({tool: "mcp__first__old", arguments: {}}), ctx, "stale")).outcome).toBe("failed");
            expect(manager.getTools().filter(tool => tool.name.startsWith("mcp__second__"))).toEqual(stable);
            expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__second__old", arguments: {}}), ctx, "healthy")).outcome).toBe("ok");
            if (action !== "refresh") expect(manager.getTools().some(tool => tool.name.startsWith("mcp__first__"))).toBe(false);
            await manager.reconnect("first");
            expect(manager.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
            expect((await frozen.executeTool("mcp_call", JSON.stringify({tool: "mcp__first__old", arguments: {}}), ctx, "old-connection")).outcome).toBe("failed");
            await discover();
            expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__first__old", arguments: {}}), ctx, "new-connection")).outcome).toBe("ok");
            expect(manager.getTools().filter(tool => tool.name.startsWith("mcp__second__"))).toEqual(stable);
        } finally {await manager.closeAll();}
        expect(manager.getTools()).toHaveLength(0);
        await expect(manager.reconnect("first")).rejects.toThrow("is closed");
    });
});

test("重连重新批准修改后的配置，关闭不等待迟到的批准或复活进程", async () => withTempProject(async (cwd, storage) => {
    const path = join(cwd, ".hicode", "mcp.json");
    await mkdir(join(cwd, ".hicode"), {recursive: true});
    const config = {type: "stdio", command: process.execPath,
        args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000};
    await writeFile(path, JSON.stringify({mcpServers: {fixture: config}}));
    let approvals = 0;
    let ready!: () => void;
    let allow!: (decision: "enable") => void;
    const waiting = new Promise<void>(resolve => {ready = resolve;});
    const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment, sources: ["project"],
        requestApproval: async () => {
            approvals++;
            if (approvals === 1) return "enable";
            ready();
            return new Promise<"enable">(resolve => {allow = resolve;});
        }});
    await manager.initialize();
    try {
        expect(manager.getSnapshots()[0]?.status).toBe("connected");
        await writeFile(path, JSON.stringify({mcpServers: {fixture: {...config, args: [...config.args, "changed"]}}}));
        const reconnect = manager.reconnect("fixture");
        await waiting;
        await expect(manager.reconnect("fixture")).rejects.toThrow("is connecting");
        await manager.closeAll();
        allow("enable");
        await reconnect;
        expect(approvals).toBe(2);
        expect(manager.getTools()).toHaveLength(0);
        expect(manager.getSnapshots()[0]?.status).toBe("closed");
    } finally {allow?.("enable"); await manager.closeAll();}
}));

test.each(["same", "changed", "slow"])("catalog refresh %s preserves unchanged capabilities and gates execution", async action => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(storage.hicodeHome, {recursive: true});
        await writeFile(join(storage.hicodeHome, "mcp.json"), JSON.stringify({mcpServers: {fixture: {
            command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000,
        }}}));
        const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment, headless: true});
        try {
            await manager.initialize();
            const before = manager.getTools();
            const runtime = createToolRuntime({getAdditionalTools: () => manager.getTools()});
            const frozen = createToolRuntime({additionalTools: before});
            const ctx = createTestContext(cwd, {mcpManager: manager});
            for (const target of [runtime, frozen]) {
                target.getToolSchemas();
                await target.executeTool("tool_search", JSON.stringify({names: ["mcp__fixture__control","mcp__fixture__old"]}), ctx, "discover");
                target.getToolSchemas();
            }
            expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__control", arguments: {action}}), ctx, "trigger")).outcome).toBe("ok");
            if (action === "slow") {
                await until(() => manager.getSnapshots()[0]?.status === "refreshing");
                expect(runtime.getToolSchemas().map(t => t.function.name)).toContain("mcp_call");
                const abort = new AbortController();
                const waiting = runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__old", arguments: {}}), createTestContext(cwd, {mcpManager: manager, signal: abort.signal}), "cancel-refresh");
                abort.abort(new Error("cancel-refresh-wait"));
                expect((await waiting).outcome).toBe("interrupted");
                // The aborted waiter does not cancel the Root-owned refresh.
                const result = await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__old", arguments: {}}), ctx, "during-refresh");
                expect(result.outcome).toBe("ok");
                expect(manager.getSnapshots()[0]?.status).toBe("connected");
            }
            await until(() => manager.getSnapshots()[0]?.catalog?.notifications === 1 && manager.getSnapshots()[0]?.status === "connected");
            const visible = runtime.getToolSchemas().map(t => t.function.name);
            expect(visible).toContain("mcp_call");
            expect(manager.getTools().find(t => t.name === "mcp__fixture__control")).toBe(before[0]);
            const catalog = manager.getSnapshots()[0]?.catalog;
            if (action === "changed") {
                expect(visible).not.toContain("mcp__fixture__old");
                expect(catalog?.changed).toEqual(["mcp__fixture__old"]);
                expect((await frozen.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__old", arguments: {}}), ctx, "stale-definition")).outcome).toBe("failed");
                await runtime.executeTool("tool_search", JSON.stringify({names: ["mcp__fixture__old"]}), ctx, "rediscover");
                runtime.getToolSchemas();
                expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__old", arguments: {}}), ctx, "updated")).outcome).toBe("ok");
            } else {
                expect(visible).not.toContain("mcp__fixture__old");
                expect(catalog).toMatchObject({revision: 1, changed: [], removed: [], unchanged: 2});
                expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__old", arguments: {}}), ctx, "unchanged")).outcome).toBe("ok");
            }
        } finally {await manager.closeAll();}
    });
});

test("normalized name collisions retain the first remote definition and its unchanged capability", async () => {
    await withTempProject(async (cwd, storage) => {
        const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment, sources: [],
            hostServers: [{name: "fixture", command: process.execPath,
                args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts"), "--colliding-tools"]}],
            requestApproval: async () => "enable"});
        try {
            await manager.initialize();
            expect(manager.getSnapshots()[0]?.error).toContain("conflicting normalized names");
            const first = manager.getTools().find(tool => tool.name === "mcp__fixture__read_item");
            expect(first?.isReadOnly?.({})).toBe(true);
            const runtime = createToolRuntime({getAdditionalTools: () => manager.getTools()});
            const ctx = createTestContext(cwd);
            runtime.getToolSchemas();
            await runtime.executeTool("tool_search", '{"names":["mcp__fixture__control","mcp__fixture__read_item"]}', ctx, "discover");
            runtime.getToolSchemas();
            expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__control", arguments: {"action":"same"}}), ctx, "refresh")).outcome).toBe("ok");
            await until(() => manager.getSnapshots()[0]?.catalog?.notifications === 1 && manager.getSnapshots()[0]?.status === "connected");
            expect(manager.getTools().find(tool => tool.name === first?.name)).toBe(first);
            expect(manager.getSnapshots()[0]?.catalog).toMatchObject({changed: [], removed: [], unchanged: 3});
            expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__fixture__read_item", arguments: {}}), ctx, "retained")).outcome).toBe("ok");
        } finally {await manager.closeAll();}
    });
});

test("refreshing one MCP catalog does not block local tools or another server", async () => withTempProject(async (cwd, storage) => {
    const release = join(cwd, "release-refresh");
    await mkdir(storage.hicodeHome, {recursive:true});
    const config = {command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts"), release], timeoutMs: 2000};
    await writeFile(join(storage.hicodeHome, "mcp.json"), JSON.stringify({mcpServers: {first: config, second: config}}));
    await writeFile(join(cwd, "local.txt"), "local content");
    const manager = createMcpManager({cwd,storage,childEnvironment:testChildEnvironment,headless:true});
    try {
        await manager.initialize();
        const runtime = createToolRuntime({getAdditionalTools:()=>manager.getTools()});
        const ctx = createTestContext(cwd,{mcpManager:manager});
        runtime.getToolSchemas();
        await runtime.executeTool("tool_search", '{"names":["mcp__first__control","mcp__second__old"]}',ctx,"discover");
        runtime.getToolSchemas();
        await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__first__control", arguments: {"action":"paused"}}),ctx,"pause");
        await until(()=>manager.getSnapshots()[0]?.status==="refreshing");
        expect((await runtime.executeTool("read_file",'{"path":"local.txt"}',ctx,"local")).outcome).toBe("ok");
        expect((await runtime.executeTool("mcp_call", JSON.stringify({tool: "mcp__second__old", arguments: {}}),ctx,"healthy")).outcome).toBe("ok");
        expect(manager.getSnapshots()[0]?.status).toBe("refreshing");
    } finally {await writeFile(release,"done");await manager.closeAll();}
}));
