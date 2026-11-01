import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {createMcpManager} from "../../src/mcp/manager.js";
import {resolvePermission} from "../../src/permissions/resolvePermission.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createTestContext} from "../helpers/testContext.js";
import type {McpManagerLike, McpApprovalDecision} from "../../src/mcp/types.js";

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > deadline) throw Error("MCP fixture timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test("trusted service retains policy across restart and catalog additions; changed config needs fresh approval", async () => withTempProject(async (cwd, storage) => {
    const path = join(cwd, ".mcp.json");
    const config = {command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000};
    await writeFile(path, JSON.stringify({mcpServers: {fixture: config}}));
    let approvals = 0;
    const make = () => createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment,
        requestApproval: async () => {approvals++; return "enable";}});
    const ctx = createTestContext(cwd);
    const find = (manager: McpManagerLike, suffix: string) => manager.getTools().find(tool => tool.name === `mcp__fixture__${suffix}`)!;
    let manager = make();
    try {
        await manager.initialize(); expect(approvals).toBe(1);
        const hash = manager.getSnapshots()[0]!.configHash!;
        expect(manager.getSnapshots()[0]!.toolPolicy).toBeUndefined();
        await find(manager, "control").execute({action: "changed"}, ctx, {toolCallId: "change"});
        await until(() => find(manager, "old")?.isReadOnly?.({}) === false);
        const oldTool = find(manager, "old");
        expect((await resolvePermission(oldTool, {}, ctx)).behavior).toBe("allow");
        await manager.setToolPolicy("fixture", hash, {exceptions: {[oldTool.name]: "ask"}});
        expect(await resolvePermission(find(manager, "old"), {}, ctx)).toMatchObject({behavior: "ask", allowPersistent: false});
        await expect(oldTool.execute({}, ctx, {toolCallId: "stale"})).rejects.toThrow("definition changed");
        await expect(manager.setToolPolicy("fixture", "bad-hash", {exceptions: {}})).rejects.toThrow("connection changed");
        await expect(manager.setToolPolicy("fixture", hash, {exceptions: {mcp__other__tool: "ask"}})).rejects.toThrow("Unknown MCP");
        await manager.closeAll(); manager = make(); await manager.initialize(); expect(approvals).toBe(1);
        expect((await resolvePermission(find(manager, "old"), {}, ctx)).behavior).toBe("ask");
        await find(manager, "control").execute({action: "new-write"}, ctx, {toolCallId: "refresh"});
        await until(() => Boolean(find(manager, "new")));
        expect(find(manager, "new").isReadOnly?.({})).toBe(false);
        expect(manager.getSnapshots()[0]!.toolPolicy?.exceptions[oldTool.name]).toBe("ask");
        expect((await resolvePermission(find(manager, "new"), {}, ctx)).behavior).toBe("allow");
        await manager.setToolPolicy("fixture", hash, {exceptions: {[oldTool.name]: "deny"}});
        await find(manager, "control").execute({action: "changed"}, ctx, {toolCallId: "write"});
        await until(() => find(manager, "old")?.isReadOnly?.({}) === false);
        expect((await resolvePermission(find(manager, "old"), {}, ctx)).behavior).toBe("deny");
        await manager.setToolPolicy("fixture", hash, {exceptions: {}});
        await writeFile(path, JSON.stringify({mcpServers: {fixture: {...config, args: [...config.args, "changed"]}}}));
        await manager.reconnect("fixture"); expect(approvals).toBe(2);
        expect(manager.getSnapshots()[0]!.toolPolicy).toBeUndefined();
        await find(manager, "control").execute({action: "changed"}, ctx, {toolCallId: "write-again"});
        await until(() => find(manager, "old")?.isReadOnly?.({}) === false);
        expect((await resolvePermission(find(manager, "old"), {}, ctx)).behavior).toBe("allow");
    } finally {await manager.closeAll();}
}));

test("policy persistence failure leaves running service permissions unchanged", async () => withTempProject(async (cwd, storage) => {
    await writeFile(join(cwd, ".mcp.json"), JSON.stringify({mcpServers: {fixture: {
        command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp/lifecycleServer.ts")], timeoutMs: 2000,
    }}}));
    const manager = createMcpManager({cwd, storage, sources: ["project"], childEnvironment: testChildEnvironment, requestApproval: async () => "enable"});
    try {
        await manager.initialize(); const snapshot = manager.getSnapshots()[0]!; const tools = manager.getTools();
        await writeFile(join(storage.hicodeHome, "mcp-approvals.json"), "corrupt");
        await expect(manager.setToolPolicy("fixture", snapshot.configHash!, {exceptions: {}})).rejects.toThrow();
        expect(manager.getSnapshots()[0]?.toolPolicy).toBeUndefined(); expect(manager.getTools()).toEqual(tools);
    } finally {await manager.closeAll();}
}));

test("close cancels a pending human approval without waiting for the UI", async () => withTempProject(async (cwd, storage) => {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<McpApprovalDecision>();
    const manager = createMcpManager({cwd, storage, sources: [], childEnvironment: testChildEnvironment,
        hostServers: [{name: "fixture", command: process.execPath, args: []}],
        requestApproval: async () => {entered.resolve(); return answer.promise;}});
    const initializing = manager.initialize();
    try {
        await entered.promise;
        await manager.closeAll();
        await initializing;
        expect(manager.getTools()).toEqual([]);
        expect(manager.getSnapshots()[0]?.status).toBe("closed");
    } finally {answer.resolve("cancel"); await manager.closeAll();}
}));
