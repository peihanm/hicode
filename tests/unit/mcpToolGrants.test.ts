import {expect, test} from "bun:test";
import {mkdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {getMcpApproval, saveMcpApproval} from "../../src/mcp/approval.js";
import {withTempProject} from "../helpers/tempProject.js";

test("enablement and tool restrictions are bound to project and config", async () => withTempProject(async cwd => {
    const path = join(cwd, "approvals.json"), identity = {projectPath: cwd, configHash: "a".repeat(64)};
    await saveMcpApproval(path, identity, "blender");
    expect(await getMcpApproval(path, identity, "blender")).toEqual({decision: "allow"});
    const policy = {exceptions: {mcp__blender__execute: "ask" as const}};
    await saveMcpApproval(path, identity, "blender", policy);
    expect(await getMcpApproval(path, identity, "blender")).toEqual({decision: "allow", toolPolicy: policy});
    expect(await getMcpApproval(path, {...identity, configHash: "b".repeat(64)}, "blender")).toEqual({decision: "pending"});
    expect(await getMcpApproval(path, {...identity, projectPath: cwd + "/other"}, "blender")).toEqual({decision: "pending"});
    expect(await getMcpApproval(path, identity, "other")).toEqual({decision: "pending"});
    const old = await Bun.file(path).text();
    await expect(saveMcpApproval(path, identity, "blender", {exceptions: {bash: "ask"}})).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe(old);
}));

test("invalid and symlink policy storage fails closed", async () => withTempProject(async cwd => {
    const path = join(cwd, "approvals.json"), target = join(cwd, "target.json"), identity = {projectPath: cwd, configHash: "a".repeat(64)};
    await writeFile(target, "{}"); await symlink(target, path);
    await expect(saveMcpApproval(path, identity, "blender", {exceptions: {}})).rejects.toThrow();
    expect(await Bun.file(target).text()).toBe("{}");
    await mkdir(join(cwd, "bad"));
    const bad = join(cwd, "bad", "approvals.json");
    await writeFile(bad, JSON.stringify({version: 2, approvals: [{...identity, serverName: "blender", decidedAt: new Date().toISOString(), toolPolicy: {exceptions: {mcp__blender__execute: "invalid"}}}]}));
    await expect(getMcpApproval(bad, identity, "blender")).rejects.toThrow();
}));

test.each([1, 3])("unsupported approval version %s is not reused or overwritten", async version => withTempProject(async cwd => {
    const path = join(cwd, "approvals.json"), identity = {projectPath: cwd, configHash: "a".repeat(64)};
    const content = JSON.stringify({version, approvals: [{...identity, serverName: "fixture", decision: "deny", decidedAt: new Date().toISOString()}]});
    await writeFile(path, content);
    await expect(getMcpApproval(path, identity, "fixture")).rejects.toThrow("expected version 2");
    await expect(saveMcpApproval(path, identity, "fixture")).rejects.toThrow("expected version 2");
    expect(await Bun.file(path).text()).toBe(content);
}));
