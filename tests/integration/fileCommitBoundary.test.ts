import {expect, test} from "bun:test";
import {chmod, mkdir, readFile, readdir, realpath, rename, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {FileCommitCoordinator, prepareFileCommit} from "../../src/tools/shared/fileCommit.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";

const calls = [
    {name: "edit_file", input: {path: "file.txt", edits: [{old_string: "before", new_string: "after"}]}},
    {name: "write_file", input: {path: "file.txt", content: "after"}},
] as const;

test("取消排队的写入不会阻塞后续提交", async () => {
    const coordinator = new FileCommitCoordinator();
    let release!: () => void;
    const first = coordinator.exclusive(new AbortController().signal, () => new Promise<void>(resolve => {release = resolve;}));
    const controller = new AbortController();
    let called = false;
    const second = coordinator.exclusive(controller.signal, async () => {called = true;});
    controller.abort("user-cancel");
    try {await expect(second).rejects.toThrow(); expect(called).toBe(false);} finally {release();}
    await first;
    expect(await coordinator.exclusive(new AbortController().signal, async () => "next")).toBe("next");
});

for (const change of ["content", "identity", "parent", "cancel", "new-file"] as const) {
    test(`最终提交保护 ${change}，不覆盖外部文件且清理暂存文件`, async () => {
        await withTempProject(async cwd => {
            await mkdir(join(cwd, "target")); await mkdir(join(cwd, "external"));
            const path = join(cwd, "target", "file.txt");
            if (change !== "new-file") await writeFile(path, "before");
            const canonical = join(await realpath(join(cwd, "target")), "file.txt");
            const commit = prepareFileCommit(path, canonical, change === "new-file" ? null : "before");
            const controller = new AbortController();
            if (change === "content" || change === "new-file") await writeFile(path, "external");
            if (change === "identity") {await writeFile(join(cwd, "replacement"), "before"); await rename(join(cwd, "replacement"), path);}
            if (change === "parent") {
                await writeFile(join(cwd, "external", "file.txt"), "before");
                await rename(join(cwd, "target"), join(cwd, "original"));
                await symlink(join(cwd, "external"), join(cwd, "target"));
            }
            if (change === "cancel") controller.abort("user-cancel");
            await expect(commit("after", controller.signal)).rejects.toThrow();
            expect(await readFile(path, "utf8")).toBe(change === "content" || change === "new-file" ? "external" : "before");
            expect((await readdir(join(cwd, "target"))).filter(name => name.startsWith(".hicode-write-"))).toEqual([]);
        });
    });
}

for (const call of calls) test(`${call.name} 拒绝未观察到的外部修改，保留文件`, async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "file.txt"); await writeFile(path, "before");
        const ctx = createTestContext(cwd); const tools = createToolRuntime();
        await executeDeliveredTool(tools, "read_file", '{"path":"file.txt"}', ctx, "read");
        await writeFile(path, "external");
        const result = await tools.executeTool(call.name, JSON.stringify(call.input), ctx, "change");
        expect(result.outcome).not.toBe("ok");
        expect(result.uiData).toBeUndefined();
        expect(await readFile(path, "utf8")).toBe("external");
    });
});

test("提交后取消仍报告真实 FileChange，文件权限保留", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "file.txt"); await writeFile(path, "before"); await chmod(path, 0o751);
        const controller = new AbortController();
        const coordinator = new FileCommitCoordinator();
        const original = coordinator.run.bind(coordinator);
        coordinator.run = async (...args) => {const result = await original(...args); controller.abort("user-cancel"); return result;};
        const ctx = createTestContext(cwd, {signal: controller.signal, fileCommits: coordinator});
        const tools = createToolRuntime();
        await executeDeliveredTool(tools, "read_file", '{"path":"file.txt"}', ctx, "read");
        const result = await tools.executeTool("edit_file", JSON.stringify(calls[0].input), ctx, "edit");
        expect(result.outcome).toBe("ok"); expect(result.uiData).toMatchObject({type: "file_change"});
        expect(await readFile(path, "utf8")).toBe("after"); expect((await stat(path)).mode & 0o777).toBe(0o751);
    });
});

test("不需要快照存储即可创建项目外多级文件并继续编辑", async () => {
    await withTempProject(async root => {
        const cwd = join(root, "project"); await mkdir(cwd);
        const ctx = createTestContext(cwd, {workspaceBoundary: root}); const tools = createToolRuntime();
        const path = join(root, "scratch", "turn", "smoke.mjs");
        expect((await tools.executeTool("write_file", JSON.stringify({path, content: "export {};"}), ctx, "scratch")).outcome).toBe("ok");
        expect((await tools.executeTool("write_file", '{"path":"main.js","content":"const value = 1;"}', ctx, "main")).outcome).toBe("ok");
        const result = await tools.executeTool("edit_file", '{"path":"main.js","edits":[{"old_string":"const","new_string":"let"}]}', ctx, "edit");
        expect(result.outcome).toBe("ok");
        expect(await readFile(join(cwd, "main.js"), "utf8")).toBe("let value = 1;");
    });
});
