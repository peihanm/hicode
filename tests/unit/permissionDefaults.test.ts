import {expect, test} from "bun:test";
import {mkdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {resolvePermission} from "../../src/permissions/resolvePermission.js";
import {webFetchTool} from "../../src/tools/webFetch/webFetch.js";
import {writeFileTool} from "../../src/tools/writeFile/writeFile.js";
import {bashTool} from "../../src/tools/bash/bash.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import type {SandboxStatus} from "../../src/sandbox/types.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

test.each(["ask", "auto-review"] as const)("open public GET allows directly in %s; rules and URL validation still win", async permissionMode => {
    await withTempProject(async cwd => {
        let status: SandboxStatus = {kind: "ready", platform: "macos", networkMode: "open", warnings: []};
        const sandbox = {...createDisabledSandboxRuntime(), get status() {return status;}};
        const ctx = createTestContext(cwd, {permissionMode, shellRunner: createShellRunner(sandbox, testChildEnvironment)});
        const input = webFetchTool.parameters.parse({url: "https://example.com/docs"});
        expect((await resolvePermission(webFetchTool, input, ctx)).behavior).toBe("allow");
        ctx.permissionRules.ask.push({toolName: "web_fetch", content: "domain:example.com", source: "host"});
        expect((await resolvePermission(webFetchTool, input, ctx)).behavior).toBe("ask");
        ctx.permissionRules.deny.push({toolName: "web_fetch", content: "domain:example.com", source: "host"});
        expect((await resolvePermission(webFetchTool, input, ctx)).behavior).toBe("deny");
        ctx.permissionRules.ask = []; ctx.permissionRules.deny = [];
        for (const args of [{url: "http://127.0.0.1"}, {...input, resolved_addresses: ["127.0.0.1"]}]) {
            expect((await resolvePermission(webFetchTool, webFetchTool.parameters.parse(args), ctx)).behavior).toBe("deny");
        }
        status = {kind: "ready", platform: "macos", networkMode: "restricted", warnings: []};
        expect((await resolvePermission(webFetchTool, input, ctx)).behavior).toBe("ask");
        status = {kind: "unavailable", reason: "fixture", warnings: []};
        expect((await resolvePermission(webFetchTool, input, ctx)).behavior).toBe("ask");
    });
});

test.each(["ask", "auto-review"] as const)("project edits/builds and an authorized directory bypass review in %s", async permissionMode => {
    await withTempProject(async root => {
        const cwd = join(root, "project"), extra = join(root, "extra");
        await mkdir(cwd); await mkdir(extra);
        let reviews = 0;
        const ctx = createTestContext(cwd, {permissionMode, workspaceBoundary: root, directoryAccess: createDirectoryAccessRuntime({cwd, hardBoundary: root}), canUseTool: async () => {reviews++; return {behavior: "deny", message: "unexpected"};}});
        ctx.approvalReviewer = async () => {reviews++; return {decision: "deny", risk: "low", reason: "unexpected"};};
        expect((await executeToolResult("write_file", JSON.stringify({path: "code.ts", content: "ok"}), ctx, "local")).outcome).toBe("ok");
        const args = bashTool.parameters.parse({command: "bun run build"});
        expect((await resolvePermission(bashTool, args, ctx)).behavior).toBe("allow");
        expect((await resolvePermission(bashTool, {...args, sandbox_permissions: "require_escalated", justification: "host access"}, ctx)).behavior).toBe("ask");
        const target = {path: join(extra, "a.ts"), content: "ok"};
        expect((await resolvePermission(writeFileTool, target, ctx)).behavior).toBe("ask");
        await ctx.directoryAccess.grantDirectory(extra, "session");
        for (const name of ["a.ts", "b.ts"]) {
            expect((await executeToolResult("write_file", JSON.stringify({...target, path: join(extra, name)}), ctx, name)).outcome).toBe("ok");
        }
        expect(reviews).toBe(0);
        ctx.permissionRules.deny.push({toolName: "write_file", source: "host"});
        expect((await resolvePermission(writeFileTool, target, ctx)).behavior).toBe("deny");
    });
});

test("protected native writes require approval even inside a granted directory or through an alias", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        ctx.permissionRules.allow.push({toolName: "write_file", source: "project"});
        for (const path of [".env", ".env.local", ".hicode/settings.json", ".git/config", ".git/hooks/pre-commit", ".git/index"]) {
            expect(await resolvePermission(writeFileTool, {path, content: "fixture"}, ctx)).toMatchObject({behavior: "ask", allowPersistent: false});
        }
        await writeFile(join(cwd, ".env"), "fixture");
        await symlink(join(cwd, ".env"), join(cwd, "alias"));
        expect((await resolvePermission(writeFileTool, {path: "alias", content: "fixture"}, ctx)).behavior).toBe("ask");
        ctx.setPermissionMode("full-access");
        expect((await resolvePermission(writeFileTool, {path: ".env", content: "fixture"}, ctx)).behavior).toBe("allow");
        ctx.permissionRules.deny.push({toolName: "write_file", source: "host"});
        expect((await resolvePermission(writeFileTool, {path: ".env", content: "fixture"}, ctx)).behavior).toBe("deny");
    });
});
