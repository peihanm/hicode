import {expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {createMcpManager} from "../../src/mcp/index.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createTestContext} from "../helpers/testContext.js";

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("MCP transition timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test.each(["refresh", "disconnect", "invalid", "storm"])("真实 stdio 生命周期 %s 撤销旧能力、隔离其他服务、显式重连", async action => {
    await withTempProject(async (cwd, storage) => {
        const path = join(storage.pillarHome, "mcp.json");
        await mkdir(storage.pillarHome, {recursive: true});
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
        await expect(manager.reconnect("first")).rejects.toThrow("已关闭");
    });
});

test("重连重新批准修改后的配置，关闭不等待迟到的批准或复活进程", async () => withTempProject(async (cwd, storage) => {
    const path = join(cwd, ".pillar", "mcp.json");
    await mkdir(join(cwd, ".pillar"), {recursive: true});
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
        await expect(manager.reconnect("fixture")).rejects.toThrow("正在连接");
        await manager.closeAll();
        allow("always");
        await reconnect;
        expect(approvals).toBe(2);
        expect(manager.getTools()).toHaveLength(0);
        expect(manager.getSnapshots()[0]?.status).toBe("closed");
    } finally {allow?.("always"); await manager.closeAll();}
}));
