import {expect, test} from "bun:test";
import {mkdir, readFile, realpath, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, parse} from "node:path";
import {cliTemporaryDirectories} from "../../src/cli/temporaryDirectories.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";

test("CLI 临时目录为 canonical 路径，文件写入无需审批且仍保留显式 deny", async () => {
    const roots = await cliTemporaryDirectories();
    expect(roots).toContain(await realpath(tmpdir()));
    if (process.platform !== "win32") expect(roots).toContain(await realpath("/tmp"));
    await withTempProject(async root => {
        const cwd = join(root, "workspace");
        await mkdir(cwd);
        const access = createDirectoryAccessRuntime({cwd, hardBoundary: parse(cwd).root, initialDirectories: roots});
        await access.initialize();
        const ctx = createTestContext(cwd, {directoryAccess: access, workspaceBoundary: parse(cwd).root,
            permissionMode: "ask", canUseTool: async () => {throw new Error("Unexpected approval");}});
        const file = join(root, "backup.txt");
        const result = await executeToolResult("write_file", JSON.stringify({path: file, content: "backup"}), ctx, "tmp-write");
        expect(result.outcome).toBe("ok");
        expect(await readFile(file, "utf8")).toBe("backup");
        ctx.permissionRules.deny.push({toolName: "write_file", source: "local"});
        expect((await executeToolResult("write_file", JSON.stringify({path: join(root, "denied.txt"), content: "no"}), ctx, "tmp-deny")).outcome).toBe("denied");
    });
});

test("临时目录链接不能扩大授权，Host 未声明目录时不自动授予", async () => {
    await withTempProject(async root => {
        const cwd = join(root, "workspace");
        await mkdir(cwd);
        const access = createDirectoryAccessRuntime({cwd, hardBoundary: parse(cwd).root, initialDirectories: await cliTemporaryDirectories()});
        const link = join(root, "outside");
        await symlink("/etc", link);
        expect(await access.canAccess(join(link, "hicode-must-not-write"))).toBe(false);
        const host = createDirectoryAccessRuntime({cwd, hardBoundary: cwd});
        expect(await host.canAccess(join(root, "backup.txt"))).toBe(false);
    });
});
