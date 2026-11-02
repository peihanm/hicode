import {expect, test} from "bun:test";
import {chmod, mkdir, open, readFile, readdir, realpath, rename, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {FileCommitCoordinator, prepareFileCommit} from "../../src/tools/files/io.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";
import {spawn} from "node:child_process";

test("write_file rejects a FIFO without blocking execution or cancellation", async () => {
    await withTempProject(async cwd => {
        const fifo = join(cwd, "pipe");
        const make = Bun.spawn(["mkfifo", fifo], {stdout: "pipe", stderr: "pipe"});
        expect(await make.exited).toBe(0);
        const program = `
            import {createTestContext} from ${JSON.stringify(new URL("../helpers/testContext.ts", import.meta.url).pathname)};
            import {createToolRuntime} from ${JSON.stringify(new URL("../../src/tools/runtime.ts", import.meta.url).pathname)};
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort('user-cancel'), 100);
            const result = await createToolRuntime().executeTool('write_file', '{"path":"pipe","content":"x"}',
                createTestContext(${JSON.stringify(cwd)}, {signal: controller.signal}), 'fifo');
            clearTimeout(timer);
            console.log(JSON.stringify({outcome: result.outcome, content: result.modelContent}));
        `;
        const child = spawn(process.execPath, ["--eval", program], {cwd, stdio: ["ignore", "pipe", "pipe"]});
        let output = "", errors = "";
        child.stdout.on("data", data => {output += data;});
        child.stderr.on("data", data => {errors += data;});
        const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
        try {
            const code = await new Promise<number | null>(resolve => child.on("close", resolve));
            expect(code).toBe(0);
            expect(errors).toBe("");
            expect(JSON.parse(output)).toMatchObject({outcome: "failed"});
            expect(output).toContain("Only regular files");
        } finally {clearTimeout(timer); child.kill("SIGKILL");}
        expect((await stat(fifo)).isFIFO()).toBe(true);
    });
});

test("write_file rejects directories, symlinks and oversized targets before overwriting", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "directory"));
        await writeFile(join(cwd, "target"), "original");
        await symlink(join(cwd, "target"), join(cwd, "link"));
        const large = await open(join(cwd, "large"), "w");
        try {await large.truncate(20 * 1024 * 1024 + 1);} finally {await large.close();}
        const tools = createToolRuntime();
        const ctx = createTestContext(cwd);
        for (const path of ["directory", "link", "large"]) {
            const result = await tools.executeTool("write_file", JSON.stringify({path, content: "replacement"}), ctx, path);
            expect(result.outcome).toBe("failed");
            expect(result.uiData).toBeUndefined();
        }
        expect(await readFile(join(cwd, "target"), "utf8")).toBe("original");
        expect((await stat(join(cwd, "large"))).size).toBe(20 * 1024 * 1024 + 1);
        const device = await tools.executeTool("write_file", '{"path":"/dev/null","content":"replacement"}',
            createTestContext(cwd, {permissionMode: "full-access"}), "device");
        expect(device.outcome).toBe("failed");
        expect(device.modelContent).toContain("Only regular files");
        expect((await stat("/dev/null")).isCharacterDevice()).toBe(true);
    });
});

const calls = [
    {name: "edit_file", input: {path: "file.txt", edits: [{old_string: "before", new_string: "after"}]}},
    {name: "write_file", input: {path: "file.txt", content: "after"}},
] as const;

test("commit rereads reject a target that grew beyond the read budget and clean staged output", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "growing.txt");
        await writeFile(path, "before");
        const canonical = await realpath(path);
        const commit = prepareFileCommit(path, canonical, "before");
        const oversized = 20 * 1024 * 1024 + 1;
        const file = await open(path, "r+");
        try {await file.truncate(oversized);} finally {await file.close();}
        expect(() => prepareFileCommit(path, canonical, "before")).toThrow("safe-read limit");
        await expect(commit("after", new AbortController().signal)).rejects.toThrow("safe-read limit");
        expect((await stat(path)).size).toBe(oversized);
        expect((await readdir(cwd)).filter(name => name.startsWith(".hicode-write-"))).toEqual([]);
    });
});

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
