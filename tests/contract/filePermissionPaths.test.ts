import {expect, test} from "bun:test";
import {mkdir, readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {matchesToolPermissionRule} from "../../src/permissions/resolvePermission.js";
import {readFileTool} from "../../src/tools/readFile/readFile.js";
import {hicodeSettingsFileSchema} from "../../src/settings/schema.js";
import {loadHiCodeSettings} from "../../src/settings/load.js";

test("文件 deny 覆盖相对/绝对路径、目录别名和不存在的写目标", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "private"));
        await writeFile(join(cwd, "private", "data.txt"), "private evidence");
        await symlink(join(cwd, "private"), join(cwd, "alias"));
        const ctx = createTestContext(cwd, {workspaceBoundary: cwd});
        ctx.permissionRules.deny.push(
            {toolName: "read_file", content: "private/**", source: "local"},
            {toolName: "write_file", content: "private/**", source: "local"},
        );
        const runtime = createToolRuntime();
        for (const path of ["private/data.txt", "./private/../private/data.txt", join(cwd, "private", "data.txt"), "alias/data.txt"]) {
            const result = await runtime.executeTool("read_file", JSON.stringify({path}), ctx, path);
            expect(result.outcome).toBe("denied");
            expect(result.modelContent).not.toContain("private evidence");
        }
        const write = await runtime.executeTool("write_file", JSON.stringify({path: "alias/new.txt", content: "x"}), ctx, "new");
        expect(write.outcome).toBe("denied");
        expect(await matchesToolPermissionRule(readFileTool, {path: "alias/data.txt"}, "read_file(private/**)", cwd)).toBe(true);
        expect(await matchesToolPermissionRule(readFileTool, {path: "alias/data.txt"}, "bash(git status:*)", cwd)).toBe(false);
    });
});

test("文件规则只匹配目标，正文包含路径文字不影响写入", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        ctx.permissionRules.deny.push({toolName: "write_file", content: "private/**", source: "local"});
        const result = await createToolRuntime().executeTool("write_file",
            JSON.stringify({path: "public.txt", content: "private/data.txt"}), ctx, "write");
        expect(result.outcome).toBe("ok");
        expect(await readFile(join(cwd, "public.txt"), "utf8")).toBe("private/data.txt");
    });
});

test("绝对规则解析目录别名，项目路径中的 glob 字符不参与匹配", async () => {
    await withTempProject(async cwd => {
        const project = join(cwd, "project[1]");
        await mkdir(join(project, "private"), {recursive: true});
        await writeFile(join(project, "private", "data.txt"), "protected");
        await symlink(project, join(cwd, "project-alias"));
        await symlink(join(project, "private"), join(project, "alias"));
        const ctx = createTestContext(join(cwd, "project-alias"));
        ctx.permissionRules.deny.push({toolName: "read_file", content: join(cwd, "project-alias", "private", "**"), source: "local"});
        expect((await createToolRuntime().executeTool("read_file", JSON.stringify({path: "alias/data.txt"}), ctx, "absolute")).outcome).toBe("denied");
        ctx.permissionRules.deny.splice(0, 1, {toolName: "read_file", content: "private/**", source: "local"});
        expect((await createToolRuntime().executeTool("read_file", JSON.stringify({path: "alias/data.txt"}), ctx, "relative")).outcome).toBe("denied");
    });
});

test("Bash search does not bypass explicit file rules", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "private.txt"), "private evidence");
        const ctx = createTestContext(cwd);
        ctx.permissionRules.deny.push({toolName: "read_file", content: "private.txt", source: "local"});
        const runtime = createToolRuntime();
        const result = await runtime.executeTool("bash", JSON.stringify({command: "rg -e evidence private.txt"}), ctx, "denied");
        expect(result.outcome).toBe("denied");
        expect(result.modelContent).not.toContain("private evidence");
        ctx.permissionRules.deny = [{toolName: "read_file", content: "**/*.secret", source: "local"}];
        const unsupported = await runtime.executeTool("bash", JSON.stringify({command: "rg -e evidence ."}), ctx, "unsupported");
        expect(unsupported.outcome).toBe("denied");
        expect(unsupported.modelContent).toContain("cannot safely enforce");
    });
});

test("批准期间目录别名改变后拒绝读取新目标", async () => {
    await withTempProject(async cwd => {
        for (const name of ["public", "private"]) {
            await mkdir(join(cwd, name));
            await writeFile(join(cwd, name, "data.txt"), name);
        }
        await symlink(join(cwd, "public"), join(cwd, "alias"));
        const ctx = createTestContext(cwd, {workspaceBoundary: cwd, canUseTool: async () => {
            await unlink(join(cwd, "alias"));
            await symlink(join(cwd, "private"), join(cwd, "alias"));
            return {behavior: "allow"};
        }});
        ctx.permissionRules.ask.push({toolName: "read_file", content: "public/**", source: "local"});
        const result = await createToolRuntime().executeTool("read_file", JSON.stringify({path: "alias/data.txt"}), ctx, "read");
        expect(result.outcome).toBe("denied");
        expect(result.modelContent).toContain("target");
    });
});

test("Bash explicit ask is approved once per invocation", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "public.txt"), "visible");
        let approvals = 0;
        const ctx = createTestContext(cwd, {canUseTool: async () => {approvals++; return {behavior: "allow"};}});
        ctx.permissionRules.ask.push({toolName: "bash", source: "local"});
        const result = await createToolRuntime().executeTool("bash", JSON.stringify({command: "rg -n -H -e visible public.txt"}), ctx, "whole");
        expect(result.modelContent).toContain("public.txt");
        expect(approvals).toBe(1);
    });
});

test("removed search tool rules fail configuration instead of silently losing protection", () => {
    for (const name of ["list_files", "glob", "grep"]) {
        expect(hicodeSettingsFileSchema.safeParse({permissions: {deny: [`${name}(private/**)`]}}).success).toBe(false);
    }
});

test("Settings 拒绝文件 JSON 匹配和 Bash 前缀，接受路径 glob", () => {
    for (const rule of ['read_file({"path":"x"})', "read_file(src:*)", "read_file([)", "read_file(src/**"]) {
        expect(hicodeSettingsFileSchema.safeParse({permissions: {deny: [rule]}}).success).toBe(false);
    }
    expect(hicodeSettingsFileSchema.safeParse({permissions: {deny: ["read_file(src/**)", "bash(git push:*)"]}}).success).toBe(true);
});

test("无效文件权限规则不能被跳过后按默认权限启动", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, ".hicode"));
        await writeFile(join(cwd, ".hicode", "settings.json"), JSON.stringify({
            models: {primary: {model: 42}},
            permissions: {deny: ['read_file({"path":"private.txt"})']},
        }));
        expect(() => loadHiCodeSettings({cwd, storage, sources: ["project"]})).toThrow("Invalid permission configuration");
    });
});
