import {expect, test} from "bun:test";
import {mkdir, readFile, symlink, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {matchesToolPermissionRule} from "../../src/permissions/resolvePermission.js";
import {readFileTool} from "../../src/tools/readFile/readFile.js";
import {pillarSettingsFileSchema} from "../../src/settings/schema.js";
import {loadPillarSettings} from "../../src/settings/load.js";

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

test("Grep/Glob 根目录搜索不会读取或展示 deny/ask 候选", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "private"));
        await writeFile(join(cwd, "private", "hidden.txt"), "private evidence");
        await writeFile(join(cwd, "ask.txt"), "pending evidence");
        await writeFile(join(cwd, "public.txt"), "public evidence");
        const ctx = createTestContext(cwd);
        for (const toolName of ["grep", "glob", "list_files"]) {
            ctx.permissionRules.deny.push({toolName, content: "private/**", source: "local"});
            ctx.permissionRules.ask.push({toolName, content: "ask.txt", source: "local"});
        }
        const runtime = createToolRuntime();
        for (const [name, args] of [
            ["grep", {path: ".", pattern: "evidence", output_mode: "content", search_mode: "complete"}],
            ["glob", {path: ".", pattern: "**/*.txt"}],
            ["list_files", {dir: "."}],
        ] as const) {
            const result = await runtime.executeTool(name, JSON.stringify(args), ctx, name);
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain("public");
            expect(result.modelContent).not.toContain("hidden.txt");
            expect(result.modelContent).not.toContain("ask.txt");
            expect(result.modelContent).toContain("权限");
        }
        // An explicit path can ask once; parent-directory traversal cannot silently grant it.
        const explicit = await runtime.executeTool("grep", JSON.stringify({path: "ask.txt", pattern: "pending"}), ctx, "explicit");
        expect(explicit.outcome).toBe("ok");
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
        expect(result.modelContent).toContain("目标");
    });
});

test("已批准的整工具与搜索根 ask 不会重复阻止同次遍历", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "src"));
        await writeFile(join(cwd, "src", "public.txt"), "visible");
        let approvals = 0;
        const ctx = createTestContext(cwd, {canUseTool: async () => {
            approvals++; return {behavior: "allow"};
        }});
        ctx.permissionRules.ask.push({toolName: "grep", source: "local"});
        const runtime = createToolRuntime();
        expect((await runtime.executeTool("grep", JSON.stringify({path: "src", pattern: "visible"}), ctx, "whole")).modelContent).toContain("public.txt");
        ctx.permissionRules.ask.splice(0, 1, {toolName: "grep", content: "src/**", source: "local"});
        expect((await runtime.executeTool("grep", JSON.stringify({path: "src", pattern: "visible"}), ctx, "root")).modelContent).toContain("public.txt");
        expect(approvals).toBe(2);
    });
});

test("Settings 拒绝文件 JSON 匹配和 Bash 前缀，接受路径 glob", () => {
    for (const rule of ['read_file({"path":"x"})', "read_file(src:*)", "read_file([)", "read_file(src/**"]) {
        expect(pillarSettingsFileSchema.safeParse({permissions: {deny: [rule]}}).success).toBe(false);
    }
    expect(pillarSettingsFileSchema.safeParse({permissions: {deny: ["read_file(src/**)", "bash(git push:*)"]}}).success).toBe(true);
});

test("无效文件权限规则不能被跳过后按默认权限启动", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, ".pillar"));
        await writeFile(join(cwd, ".pillar", "settings.json"), JSON.stringify({
            models: {primary: {model: 42}},
            permissions: {deny: ['read_file({"path":"private.txt"})']},
        }));
        expect(() => loadPillarSettings({cwd, storage, sources: ["project"]})).toThrow("权限配置无效");
    });
});
