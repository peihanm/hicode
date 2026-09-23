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

test.each(["skip", "abort"])("授权 %s 不持久拒绝，下一次启动仍询问且批准后才启动进程", async action => {
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
                return action === "abort" ? "deny" : "skip";
            }});
        try {
            await initial.initialize();
            expect(initial.getTools()).toHaveLength(0);
            expect(initial.getSnapshots()[0]?.status).toBe("pending-approval");
            expect(await getMcpApproval(join(storage.hicodeHome, "mcp-approvals.json"), identity, "fixture")).toBe("pending");
        } finally {await initial.closeAll();}
        let requests = 0;
        const restarted = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            requestApproval: async () => {requests++; return "once";}});
        try {
            await restarted.initialize();
            expect(requests).toBe(1);
            expect(restarted.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
        } finally {await restarted.closeAll();}
    });
});

test("永久拒绝明确显示，显式重连重新审查；跳过不清除拒绝，允许后才连接", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, ".mcp.json"), JSON.stringify({mcpServers: {fixture: {
            command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000,
        }}}));
        const loaded = await loadMcpConfig(storage, cwd, ["project"]);
        const identity = await createMcpApprovalIdentity(cwd, loaded.servers[0]!);
        const approvalPath = join(storage.hicodeHome, "mcp-approvals.json");
        const denied = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            requestApproval: async () => "deny"});
        try {
            await denied.initialize();
            expect(denied.getSnapshots()[0]).toMatchObject({status: "denied", toolCount: 0});
            expect(await getMcpApproval(approvalPath, identity, "fixture")).toBe("deny");
        } finally {await denied.closeAll();}
        const headless = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            headless: true, requestApproval: async () => {throw new Error("Headless must not request approval");}});
        try {
            await headless.initialize();
            await headless.reconnect("fixture");
            expect(headless.getSnapshots()[0]).toMatchObject({status: "denied", toolCount: 0});
            expect(await getMcpApproval(approvalPath, identity, "fixture")).toBe("deny");
        } finally {await headless.closeAll();}
        let requests = 0;
        let decision: McpApprovalDecision = "skip";
        const review = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
            requestApproval: async () => {requests++; return decision;}});
        try {
            await review.initialize();
            expect(requests).toBe(0);
            expect(review.getSnapshots()[0]?.status).toBe("denied");
            await review.reconnect("fixture");
            expect(requests).toBe(1);
            expect(review.getSnapshots()[0]?.status).toBe("denied");
            expect(review.getTools()).toHaveLength(0);
            expect(await getMcpApproval(approvalPath, identity, "fixture")).toBe("deny");
            decision = "once";
            await review.reconnect("fixture");
            expect(requests).toBe(2);
            expect(review.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
            expect(await getMcpApproval(approvalPath, identity, "fixture")).toBe("deny");
            decision = "always";
            await review.reconnect("fixture");
            expect(requests).toBe(3);
            expect(review.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
            expect(await getMcpApproval(approvalPath, identity, "fixture")).toBe("allow");
        } finally {await review.closeAll();}
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
                await target.executeTool("tool_search", JSON.stringify({query: "select:mcp__first__control,mcp__first__old,mcp__second__old"}), ctx, "load");
                target.getToolSchemas();
            };
            await discover(); await discover(frozen);
            const result = await runtime.executeTool("mcp__first__control", JSON.stringify({action}), ctx, "control");
            expect(result.outcome).toBe("ok");
            await until(() => action === "refresh" ? manager.getTools().some(tool => tool.name === "mcp__first__new") :
                ["failed", "closed"].includes(manager.getSnapshots()[0]?.status ?? ""));
            expect(runtime.toolNames).not.toContain("mcp__first__old");
            expect(runtime.getToolSchemas().map(tool => tool.function.name)).not.toContain("mcp__first__old");
            expect((await frozen.executeTool("mcp__first__old", "{}", ctx, "stale")).outcome).toBe("failed");
            expect(manager.getTools().filter(tool => tool.name.startsWith("mcp__second__"))).toEqual(stable);
            expect((await runtime.executeTool("mcp__second__old", "{}", ctx, "healthy")).outcome).toBe("ok");
            if (action !== "refresh") expect(manager.getTools().some(tool => tool.name.startsWith("mcp__first__"))).toBe(false);
            await manager.reconnect("first");
            expect(manager.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
            expect((await frozen.executeTool("mcp__first__old", "{}", ctx, "old-connection")).outcome).toBe("failed");
            await discover();
            expect((await runtime.executeTool("mcp__first__old", "{}", ctx, "new-connection")).outcome).toBe("ok");
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
    let allow!: (decision: "always") => void;
    const waiting = new Promise<void>(resolve => {ready = resolve;});
    const manager = createMcpManager({cwd, storage, childEnvironment: testChildEnvironment, sources: ["project"],
        requestApproval: async () => {
            approvals++;
            if (approvals === 1) return "always";
            ready();
            return new Promise<"always">(resolve => {allow = resolve;});
        }});
    await manager.initialize();
    try {
        expect(manager.getSnapshots()[0]?.status).toBe("connected");
        await writeFile(path, JSON.stringify({mcpServers: {fixture: {...config, args: [...config.args, "changed"]}}}));
        const reconnect = manager.reconnect("fixture");
        await waiting;
        await expect(manager.reconnect("fixture")).rejects.toThrow("is connecting");
        await manager.closeAll();
        allow("always");
        await reconnect;
        expect(approvals).toBe(2);
        expect(manager.getTools()).toHaveLength(0);
        expect(manager.getSnapshots()[0]?.status).toBe("closed");
    } finally {allow?.("always"); await manager.closeAll();}
}));

test.each(["same", "changed", "slow"])("catalog refresh %s preserves unchanged discovery and gates execution", async action => {
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
                await target.executeTool("tool_search", JSON.stringify({query: "select:mcp__fixture__control,mcp__fixture__old"}), ctx, "discover");
                target.getToolSchemas();
            }
            expect((await runtime.executeTool("mcp__fixture__control", JSON.stringify({action}), ctx, "trigger")).outcome).toBe("ok");
            if (action === "slow") {
                await until(() => manager.getSnapshots()[0]?.status === "refreshing");
                expect(runtime.getToolSchemas().map(t => t.function.name)).toContain("mcp__fixture__old");
                const abort = new AbortController();
                const waiting = manager.waitForRefresh(abort.signal);
                abort.abort(new Error("cancel-refresh-wait"));
                await expect(waiting).rejects.toThrow("cancel-refresh-wait");
                // The aborted waiter does not cancel the Root-owned refresh.
                const result = await runtime.executeTool("mcp__fixture__old", "{}", ctx, "during-refresh");
                expect(result.outcome).toBe("ok");
                expect(manager.getSnapshots()[0]?.status).toBe("connected");
            }
            await until(() => manager.getSnapshots()[0]?.catalog?.notifications === 1 && manager.getSnapshots()[0]?.status === "connected");
            const visible = runtime.getToolSchemas().map(t => t.function.name);
            expect(visible).toContain("mcp__fixture__control");
            expect(manager.getTools().find(t => t.name === "mcp__fixture__control")).toBe(before[0]);
            const catalog = manager.getSnapshots()[0]?.catalog;
            if (action === "changed") {
                expect(visible).not.toContain("mcp__fixture__old");
                expect(catalog?.changed).toEqual(["mcp__fixture__old"]);
                expect((await frozen.executeTool("mcp__fixture__old", "{}", ctx, "stale-definition")).outcome).toBe("failed");
                await runtime.executeTool("tool_search", JSON.stringify({query: "select:mcp__fixture__old"}), ctx, "rediscover");
                runtime.getToolSchemas();
                expect((await runtime.executeTool("mcp__fixture__old", "{}", ctx, "updated")).outcome).toBe("ok");
            } else {
                expect(visible).toContain("mcp__fixture__old");
                expect(catalog).toMatchObject({revision: 1, changed: [], removed: [], unchanged: 2});
                expect((await runtime.executeTool("mcp__fixture__old", "{}", ctx, "unchanged")).outcome).toBe("ok");
            }
        } finally {await manager.closeAll();}
    });
});
