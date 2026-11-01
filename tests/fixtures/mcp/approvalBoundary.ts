import {expect, mock} from "bun:test";
import {join} from "node:path";
import {readFile} from "node:fs/promises";
import * as approval from "../../../src/mcp/approval.js";
import type {connectMcpServer} from "../../../src/mcp/client.js";
import {withTempProject} from "../../helpers/tempProject.js";
import {testChildEnvironment} from "../../helpers/childEnvironment.js";

await withTempProject(async (cwd, storage) => {
    if (process.argv[2] === "fifo") {
        const path = join(cwd, "approvals.fifo");
        expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
        await expect(approval.getMcpApproval(path, {projectPath: cwd, configHash: "a".repeat(64)}, "fixture"))
            .rejects.toThrow("regular file");
        return;
    }
    const save = approval.saveMcpApproval;
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let written = false, holdSave = false;
    mock.module("../../../src/mcp/approval.js", () => ({...approval,
        saveMcpApproval: async (...args: Parameters<typeof save>) => {
            if (!holdSave) return save(...args);
            entered.resolve(); await gate.promise; await save(...args); written = true;
        },
    }));
    mock.module("../../../src/mcp/client.js", () => ({connectMcpServer: async (config: Parameters<typeof connectMcpServer>[0]) => ({
        config, tools: [], stderr: "", callTool: async () => ({content: []}), close: async () => {},
    })}));
    const {createMcpManager} = await import("../../../src/mcp/manager.js");
    const manager = createMcpManager({storage, cwd, childEnvironment: testChildEnvironment, sources: [],
        hostServers: [{name: "fixture", command: process.execPath, args: []}], requestApproval: async () => "enable"});
    try {
        await manager.initialize();
        holdSave = true;
        const snapshot = manager.getSnapshots()[0]!;
        expect(snapshot.status).toBe("connected");
        const saving = manager.setToolPolicy("fixture", snapshot.configHash!, {exceptions: {}});
        await entered.promise;
        let closed = false;
        const closing = manager.closeAll().then(() => {closed = true;});
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(closed).toBe(false);
        expect(written).toBe(false);
        gate.resolve();
        await saving;
        await closing;
        expect(written).toBe(true);
        const disk: unknown = JSON.parse(await readFile(join(storage.hicodeHome, "mcp-approvals.json"), "utf8"));
        expect(disk).toMatchObject({approvals: [{toolPolicy: {exceptions: {}}}]});
        expect(manager.getSnapshots()[0]?.status).toBe("closed");
        expect(manager.getTools()).toEqual([]);
    } finally {gate.resolve(); await manager.closeAll();}
});
