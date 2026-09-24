import {expect, test} from "bun:test";
import {mkdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {getMcpApproval, saveMcpApproval} from "../../src/mcp/approval.js";
import {withTempProject} from "../helpers/tempProject.js";

test("service policy is bound to project and config; old connection grants do not allow tools", async () => withTempProject(async cwd => {
    const path = join(cwd, "approvals.json"), identity = {projectPath: cwd, configHash: "a".repeat(64)};
    await saveMcpApproval(path, identity, "blender", "always");
    expect(await getMcpApproval(path, identity, "blender")).toEqual({decision: "allow"});
    const policy = {default: "allow" as const, exceptions: {mcp__blender__execute: "ask" as const}};
    await saveMcpApproval(path, identity, "blender", "always", policy);
    await saveMcpApproval(path, identity, "other", "deny");
    expect(await getMcpApproval(path, identity, "blender")).toEqual({decision: "allow", toolPolicy: policy});
    expect(await getMcpApproval(path, {...identity, configHash: "b".repeat(64)}, "blender")).toEqual({decision: "pending"});
    expect(await getMcpApproval(path, {...identity, projectPath: cwd + "/other"}, "blender")).toEqual({decision: "pending"});
    expect(await getMcpApproval(path, identity, "other")).toEqual({decision: "deny"});
    const old = await Bun.file(path).text();
    await expect(saveMcpApproval(path, identity, "blender", "always", {default: "allow", exceptions: {bash: "allow"}})).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe(old);
}));

test("invalid and symlink policy storage fails closed", async () => withTempProject(async cwd => {
    const path = join(cwd, "approvals.json"), target = join(cwd, "target.json"), identity = {projectPath: cwd, configHash: "a".repeat(64)};
    await writeFile(target, "{}"); await symlink(target, path);
    await expect(saveMcpApproval(path, identity, "blender", "always", {default: "allow", exceptions: {}})).rejects.toThrow();
    expect(await Bun.file(target).text()).toBe("{}");
    await mkdir(join(cwd, "bad"));
    const bad = join(cwd, "bad", "approvals.json");
    await writeFile(bad, JSON.stringify({version: 1, approvals: [{...identity, serverName: "blender", decision: "allow", decidedAt: new Date().toISOString(), toolPolicy: {default: "alow", exceptions: {}}}]}));
    await expect(getMcpApproval(bad, identity, "blender")).rejects.toThrow();
}));
