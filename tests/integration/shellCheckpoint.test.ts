import {expect, test} from "bun:test";
import {readFile, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {runShellCommand} from "../../src/tools/bash/process.js";
import {createFileStateTracker} from "../../src/tools/shared/fileState.js";
import {runTrackedFileWrite} from "../../src/checkpoints/trackedWrite.js";
import {FileCommitCoordinator} from "../../src/checkpoints/fileCommit.js";
import {getCheckpointDirectory} from "../../src/checkpoints/paths.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test("大安装缓存不扫描、不回退，也不清空源码已读范围", async () => {
    await withTempProject(async (cwd, storage) => {
        const fileState = createFileStateTracker();
        const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "cache", enabled: true, fileState});
        const point = (await checkpoints.beginTurn({prompt: "实现并安装"}))!;
        const ctx = createTestContext(cwd, {fileState, toolResultStore: createTestToolResultStore(cwd, "cache", {pillarHome: storage.pillarHome}),
            shellRunner: {sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, run: runShellCommand}});
        ctx.fileCheckpoints = checkpoints;
        const tools = createToolRuntime();
        expect((await tools.executeTool("write_file", JSON.stringify({path: "App.tsx", content: "const value = 1;"}), ctx, "write")).outcome).toBe("ok");
        const script = "const fs=require('node:fs');fs.mkdirSync('.npm-cache');const fd=fs.openSync('.npm-cache/large','w');fs.ftruncateSync(fd,33*1024*1024);fs.closeSync(fd);fs.writeFileSync('package-lock.json','generated');";
        const install = await tools.executeTool("bash", JSON.stringify({command: `${quote(process.execPath)} -e ${quote(script)}`}), ctx, "install");
        expect(install.outcome).toBe("ok");
        expect(install.modelContent).not.toContain("快照");
        expect((await tools.executeTool("edit_file", JSON.stringify({path: "App.tsx", edits: [{old_string: "1", new_string: "2"}]}), ctx, "edit")).outcome).toBe("ok");
        await checkpoints.settleTurn();
        const [record] = await checkpoints.listCheckpoints();
        expect(record?.fileCoverage).toBe("complete");
        expect(record?.mutations.map(item => item.path)).toEqual(["App.tsx"]);
        expect(record?.coverageWarnings[0]?.code).toBe("bash_side_effects");
        expect((await checkpoints.restoreCode(point.checkpointId)).status).toBe("complete");
        expect(await Bun.file(join(cwd, "App.tsx")).exists()).toBe(false);
        expect(await readFile(join(cwd, "package-lock.json"), "utf8")).toBe("generated");
        expect((await stat(join(cwd, ".npm-cache/large"))).size).toBe(33 * 1024 * 1024);
    });
});

test("Bash 改源码仍要求重读；同 Turn 外部修改不被后续 Edit 掩盖", async () => {
    await withTempProject(async (cwd, storage) => {
        const fileState = createFileStateTracker();
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "external", enabled: true, fileState});
        const point = (await runtime.beginTurn({prompt: "edit"}))!;
        const ctx = createTestContext(cwd, {fileState, shellRunner: {sandboxStatus: {kind: "disabled"}, run: runShellCommand}});
        ctx.fileCheckpoints = runtime;
        const tools = createToolRuntime();
        await tools.executeTool("write_file", JSON.stringify({path: "app.txt", content: "B"}), ctx, "first");
        expect((await tools.executeTool("bash", JSON.stringify({command: "printf C > app.txt"}), ctx, "external")).outcome).toBe("ok");
        const edit = {path: "app.txt", edits: [{old_string: "C", new_string: "D"}]};
        expect((await tools.executeTool("edit_file", JSON.stringify(edit), ctx, "stale")).outcome).toBe("failed");
        await executeDeliveredTool(tools, "read_file", JSON.stringify({path: "app.txt"}), ctx, "read");
        expect((await tools.executeTool("edit_file", JSON.stringify(edit), ctx, "second")).outcome).toBe("ok");
        const restored = await runtime.restoreCode(point.checkpointId);
        expect(restored.status).toBe("conflict");
        expect(restored.conflicts[0]?.reason).toBe("external_change");
        expect(await readFile(join(cwd, "app.txt"), "utf8")).toBe("D");
    });
});

test("跨 Turn 版本断点阻止旧目标，断点之后的独立 Turn 可恢复", async () => {
    await withTempProject(async (cwd, storage) => {
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "turns", enabled: true});
        const path = join(cwd, "app.txt");
        const write = async (beforeContent: string | null, afterContent: string, toolCallId: string) => runTrackedFileWrite({
            runtime, coordinator: new FileCommitCoordinator(), signal: new AbortController().signal,
            path, beforeContent, afterContent, toolCallId,
        });
        const first = (await runtime.beginTurn({prompt: "first"}))!;
        await write(null, "B", "first"); await runtime.settleTurn();
        await writeFile(path, "C");
        const second = (await runtime.beginTurn({prompt: "second"}))!;
        await write("C", "D", "second"); await runtime.settleTurn();
        expect((await runtime.restoreCode(first.checkpointId)).status).toBe("conflict");
        expect((await runtime.restoreCode(second.checkpointId)).status).toBe("complete");
        expect(await readFile(path, "utf8")).toBe("C");
    });
});

test("第二次写入缺少完成记录不能沿用第一次 after；重启后仍阻止写入和回退", async () => {
    await withTempProject(async (cwd, storage) => {
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "pending", enabled: true});
        const path = join(cwd, "app.txt");
        const point = (await runtime.beginTurn({prompt: "pending"}))!;
        await runtime.beforeWrite({path, content: null, afterContent: "B", toolCallId: "first"});
        await writeFile(path, "B");
        await runtime.afterWrite({path, content: "B", toolCallId: "first"});
        await runtime.beforeWrite({path, content: "B", afterContent: "C", toolCallId: "second"});
        await writeFile(path, "C");
        const reopened = createFileCheckpointRuntime({storage, cwd, sessionId: "pending", enabled: true, initialHead: runtime.getHead()});
        expect((await reopened.previewRestore(point.checkpointId)).conflicts[0]?.reason).toBe("incomplete_checkpoint");
        await expect(reopened.beginTurn({prompt: "next"})).rejects.toThrow("未完成写入");
        expect((await runtime.beforeWrite({path: join(cwd, "other"), content: null, afterContent: "new", toolCallId: "other"})).captured).toBe(false);
    });
});

test("备份写入失败时不改文件且不清空其他文件证据", async () => {
    await withTempProject(async (cwd, storage) => {
        const fileState = createFileStateTracker();
        fileState.recordWrite({path: join(cwd, "known"), content: "known", modelKnowsWholeFile: true});
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "storage-failure", enabled: true, fileState});
        await runtime.beginTurn({prompt: "fail"});
        const path = join(cwd, "app.txt"); await writeFile(path, "before");
        const directory = getCheckpointDirectory(storage, cwd, "storage-failure");
        await writeFile(join(directory, "blobs", "blocker"), "fixture");
        const {hashCheckpointContent} = await import("../../src/checkpoints/fingerprint.js");
        const {mkdir} = await import("node:fs/promises");
        await mkdir(join(directory, "blobs", hashCheckpointContent("before")));
        await expect(runTrackedFileWrite({runtime, coordinator: new FileCommitCoordinator(), signal: new AbortController().signal,
            path, beforeContent: "before", afterContent: "after", toolCallId: "fail"})).rejects.toThrow("本次未写入");
        expect(await readFile(path, "utf8")).toBe("before");
        expect(fileState.check(join(cwd, "known"), "known", {requireFullRead: true})).toEqual({ok: true});
    });
});
