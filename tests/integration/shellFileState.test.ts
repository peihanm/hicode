import {expect, test} from "bun:test";
import {readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {runShellCommand} from "../../src/tools/bash/process.js";
import {createFileStateTracker} from "../../src/tools/files/state.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test("大安装缓存不扫描，也不清空源码已读范围", async () => {
    await withTempProject(async (cwd, storage) => {
        const fileState = createFileStateTracker();
        const ctx = createTestContext(cwd, {fileState, toolResultStore: createTestToolResultStore(cwd, "cache", {hicodeHome: storage.hicodeHome}),
            shellRunner: {sandboxStatus: {kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}, run: runShellCommand}});
        const tools = createToolRuntime();
        expect((await tools.executeTool("write_file", JSON.stringify({path: "App.tsx", content: "const value = 1;"}), ctx, "write")).outcome).toBe("ok");
        const script = "const fs=require('node:fs');fs.mkdirSync('.npm-cache');const fd=fs.openSync('.npm-cache/large','w');fs.ftruncateSync(fd,33*1024*1024);fs.closeSync(fd);fs.writeFileSync('package-lock.json','generated');";
        const install = await tools.executeTool("bash", JSON.stringify({command: `${quote(process.execPath)} -e ${quote(script)}`}), ctx, "install");
        expect(install.outcome).toBe("ok");
        expect(install.modelContent).not.toContain("快照");
        expect((await tools.executeTool("edit_file", JSON.stringify({path: "App.tsx", edits: [{old_string: "1", new_string: "2"}]}), ctx, "edit")).outcome).toBe("ok");
        expect(await readFile(join(cwd, "App.tsx"), "utf8")).toBe("const value = 2;");
        expect(await readFile(join(cwd, "package-lock.json"), "utf8")).toBe("generated");
        expect((await stat(join(cwd, ".npm-cache/large"))).size).toBe(33 * 1024 * 1024);
    });
});

test("Bash 修改后按当前目标编辑，过期目标失败且整体覆盖仍需重读", async () => {
    await withTempProject(async cwd => {
        const fileState = createFileStateTracker();
        const ctx = createTestContext(cwd, {fileState, shellRunner: {sandboxStatus: {kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}, run: runShellCommand}});
        const tools = createToolRuntime();
        await tools.executeTool("write_file", JSON.stringify({path: "app.txt", content: "B"}), ctx, "first");
        expect((await tools.executeTool("bash", JSON.stringify({command: "printf C > app.txt"}), ctx, "external")).outcome).toBe("ok");
        const stale = {path: "app.txt", edits: [{old_string: "B", new_string: "D"}]};
        expect((await tools.executeTool("edit_file", JSON.stringify(stale), ctx, "stale")).outcome).toBe("failed");
        expect((await tools.executeTool("write_file", JSON.stringify({path:"app.txt",content:"blind"}), ctx, "overwrite")).outcome).toBe("failed");
        const edit = {path: "app.txt", edits: [{old_string: "C", new_string: "D"}]};
        expect((await tools.executeTool("edit_file", JSON.stringify(edit), ctx, "second")).outcome).toBe("ok");
        expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("D");
    });
});
