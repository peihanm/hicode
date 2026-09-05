import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {expect, test} from "bun:test";
import {chmod, mkdir, readFile, readdir, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {runShellCommand} from "../../src/tools/bash/process.js";
import {toolFileChanges} from "../../src/fileChanges/index.js";
import {FileCommitCoordinator} from "../../src/checkpoints/fileCommit.js";
import {getCheckpointDirectory} from "../../src/checkpoints/paths.js";
import {rewindSessionCheckpoint} from "../../src/checkpoints/rewind.js";
import {loadSession, saveSessionSnapshot, saveSessionTurnCheckpoint} from "../../src/session/index.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

test("受管 Shell 测试改写与生成文件后完整回退", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, "a.txt"), "before");
        const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "shell", enabled: true});
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "shell", {pillarHome: storage.pillarHome}), shellRunner: {sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, run: runShellCommand}});
        ctx.fileCheckpoints = checkpoints;
        const checkpoint = await checkpoints.beginTurn({prompt: "格式化并测试"});
        const tools = createToolRuntime();
        const result = await tools.executeTool("bash", JSON.stringify({command: "printf after > a.txt && printf generated > new.txt"}), ctx, "shell");
        expect(result.outcome).toBe("ok");
        await checkpoints.settleTurn();
        expect((await checkpoints.listCheckpoints())[0]?.fileCoverage).toBe("complete");
        expect((await checkpoints.restoreCode(checkpoint!.checkpointId)).status).toBe("complete");
        expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("before");
        expect(await Bun.file(join(cwd, "new.txt")).exists()).toBe(false);
    });
});

test("结构化写入、测试生成文件和只读 Git 检查后，代码与会话联合 rewind", async () => {
    await withTempProject(async (cwd, storage) => {
        expect((await runShellCommand({command: "git init -q", cwd, signal: new AbortController().signal})).termination).toMatchObject({kind: "exit", code: 0});
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "joint", enabled: true});
        const checkpoint = (await runtime.beginTurn({prompt: "实现并验证"}))!;
        const base = {cwd, model: "test", sessionId: "joint", todos: [], permissionMode: "default" as const, collaborationMode: "build" as const};
        const history = [{role: "user" as const, content: "上一轮"}, {role: "assistant" as const, content: "上一轮完成"}];
        await saveSessionTurnCheckpoint(storage, {...base, checkpointId: checkpoint.checkpointId, branchId: checkpoint.branchId, prompt: "实现并验证", history});
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "joint", {pillarHome: storage.pillarHome}), shellRunner: {sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, run: runShellCommand}});
        ctx.fileCheckpoints = runtime;
        const tools = createToolRuntime();
        expect((await tools.executeTool("write_file", JSON.stringify({path: "app.txt", content: "working"}), ctx, "write")).outcome).toBe("ok");
        expect((await tools.executeTool("bash", JSON.stringify({command: "test -s app.txt && printf tested > generated.txt && git --no-optional-locks status --porcelain"}), ctx, "test")).outcome).toBe("ok");
        await runtime.settleTurn();
        await saveSessionSnapshot(storage, {...base, history: [...history, {role: "user", content: "实现并验证"}, {role: "assistant", content: "本轮完成"}], checkpointHead: runtime.getHead()});
        expect((await rewindSessionCheckpoint({storage, cwd, hardBoundary: cwd, model: "test", sessionId: "joint", checkpointId: checkpoint.checkpointId, childEnvironment: testChildEnvironment})).status).toBe("complete");
        expect(await Bun.file(join(cwd, "app.txt")).exists()).toBe(false);
        expect(await Bun.file(join(cwd, "generated.txt")).exists()).toBe(false);
        expect(loadSession(storage, cwd, "joint", "test")?.history.filter(message => message.role !== "system")).toEqual(history);
    });
});

test("Shell 写入后取消仍完成快照并保留实际 FileChange", async () => {
    await withTempProject(async (cwd, storage) => {
        const controller = new AbortController();
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "cancel", enabled: true});
        const checkpoint = (await runtime.beginTurn({prompt: "cancel"}))!;
        const ctx = createTestContext(cwd, {signal: controller.signal, toolResultStore: createTestToolResultStore(cwd, "cancel", {pillarHome: storage.pillarHome}), shellRunner: {
            sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, async run(request) {
                await writeFile(join(cwd, "written"), "committed");
                controller.abort();
                return runShellCommand(request);
            }}});
        ctx.fileCheckpoints = runtime;
        const result = await createToolRuntime().executeTool("bash", JSON.stringify({command: "printf unused"}), ctx, "cancel");
        expect(result.outcome).toBe("interrupted");
        expect(toolFileChanges(result.uiData)).toMatchObject([{path: "written", kind: "create"}]);
        expect((await runtime.restoreCode(checkpoint.checkpointId)).status).toBe("complete");
        expect(await Bun.file(join(cwd, "written")).exists()).toBe(false);
    });
});

test("500 文件快照只持久化变化；后扫新增排除路径仍 incomplete", async () => {
    await withTempProject(async (cwd, storage) => {
        const content = "fixture\n".repeat(1024);
        await Promise.all(Array.from({length: 500}, (_, index) => writeFile(join(cwd, `${index}.txt`), content)));
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "cost", enabled: true});
        await runtime.beginTurn({prompt: "cost"});
        const capture = (await runtime.beginShell({cwd, toolCallId: "cost"}))!;
        await writeFile(join(cwd, "0.txt"), "changed");
        expect((await capture.finish()).changes).toHaveLength(1);
        expect((await runtime.listCheckpoints())[0]?.mutations).toHaveLength(1);
        const blobs = join(getCheckpointDirectory(storage, cwd, "cost"), "blobs");
        const names = await readdir(blobs);
        expect(names).toHaveLength(1);
        expect((await stat(join(blobs, names[0]!))).size).toBe(Buffer.byteLength(content));
        const next = (await runtime.beginShell({cwd, toolCallId: "new-exclusion"}))!;
        await writeFile(join(cwd, ".env.new"), "fake");
        expect((await next.finish()).warning).toContain("排除路径");
        expect((await runtime.listCheckpoints())[0]?.fileCoverage).toBe("incomplete");
    });
});

test("denyRead 内容不采集且禁写，动态规则不可确认时保留回退保护", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, "private"));
        await symlink("missing", join(cwd, "private", "unreadable"));
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "deny", enabled: true, shellSnapshotDeniedReadPaths: [join(cwd, "private")]});
        await runtime.beginTurn({prompt: "deny"});
        const capture = (await runtime.beginShell({cwd, toolCallId: "deny"}))!;
        expect(capture.scope.denyWrite).toContain(join(capture.scope.root, "private"));
        expect((await capture.finish()).warning).toBeUndefined();
        const dynamic = createFileCheckpointRuntime({storage, cwd, sessionId: "glob", enabled: true, shellSnapshotDeniedReadPaths: [join(cwd, "**", "secret")]});
        await dynamic.beginTurn({prompt: "glob"});
        await expect(dynamic.beginShell({cwd, toolCallId: "glob"})).rejects.toThrow("动态");
        expect((await dynamic.listCheckpoints())[0]?.fileCoverage).toBe("incomplete");
    });
});

test("失败的 Shell 保留 binary/delete/mode 变化，回退后恢复原始 bytes 和权限", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 255, 2]));
        await writeFile(join(cwd, "mode.txt"), "same");
        await chmod(join(cwd, "mode.txt"), 0o600);
        const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "binary", enabled: true});
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "shell", {pillarHome: storage.pillarHome}), shellRunner: {sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, run: runShellCommand}});
        ctx.fileCheckpoints = checkpoints;
        const checkpoint = await checkpoints.beginTurn({prompt: "test"});
        const result = await createToolRuntime().executeTool("bash", JSON.stringify({command: "rm binary.bin; chmod 644 mode.txt; exit 1"}), ctx, "failed");
        expect(result.outcome).toBe("failed");
        expect(toolFileChanges(result.uiData).map(change => change.path).sort()).toEqual(["binary.bin", "mode.txt"]);
        await checkpoints.settleTurn();
        expect((await checkpoints.restoreCode(checkpoint!.checkpointId)).status).toBe("complete");
        expect(await readFile(join(cwd, "binary.bin"))).toEqual(Buffer.from([0, 255, 2]));
        expect((await stat(join(cwd, "mode.txt"))).mode & 0o777).toBe(0o600);
    });
});

test("pending 快照崩溃、执行后外部修改和 unsupported 都保持 fail closed", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, "a"), "before");
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "pending", enabled: true});
        const checkpoint = await runtime.beginTurn({prompt: "pending"});
        await runtime.beginShell({cwd, toolCallId: "crashed"});
        await writeFile(join(cwd, "a"), "external");
        const reopened = createFileCheckpointRuntime({storage, cwd, sessionId: "pending", enabled: true});
        expect((await reopened.restoreCode(checkpoint!.checkpointId)).status).toBe("conflict");
        expect(await readFile(join(cwd, "a"), "utf8")).toBe("external");
    });
    await withTempProject(async (cwd, storage) => {
        await writeFile(join(cwd, "a"), "before");
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "external", enabled: true});
        const checkpoint = await runtime.beginTurn({prompt: "external"});
        const capture = await runtime.beginShell({cwd, toolCallId: "run"});
        await writeFile(join(cwd, "a"), "shell");
        await capture!.finish();
        await writeFile(join(cwd, "a"), "editor");
        expect((await runtime.restoreCode(checkpoint!.checkpointId)).status).toBe("conflict");
        expect(await readFile(join(cwd, "a"), "utf8")).toBe("editor");
    });
});

test.each(["disabled", "elevated", "symlink", "oversize"])("不完整范围继续拒绝完整回退 %s", async mode => {
    await withTempProject(async (cwd, storage) => {
        if (mode === "symlink") await symlink("missing", join(cwd, "link"));
        if (mode === "oversize") await writeFile(join(cwd, "large"), Buffer.alloc(21 * 1024 * 1024));
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "unsupported", enabled: true});
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "shell", {pillarHome: storage.pillarHome}), shellRunner: {
            sandboxStatus: mode === "disabled" ? {kind: "disabled"} : {kind: "ready", platform: "macos", warnings: []}, run: runShellCommand}});
        ctx.fileCheckpoints = runtime;
        const checkpoint = await runtime.beginTurn({prompt: "unsupported"});
        await createToolRuntime().executeTool("bash", JSON.stringify({command: "printf done", ...(mode === "elevated" ? {sandbox_permissions: "require_escalated"} : {})}), ctx, "run");
        expect((await runtime.restoreCode(checkpoint!.checkpointId)).status).toBe("conflict");
    });
});

test("排除目录进入禁写 scope，Shell 快照不采集其他 Session 的并发提交", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, "node_modules"));
        await writeFile(join(cwd, "node_modules", "dep"), "dependency");
        await writeFile(join(cwd, ".env"), "FAKE_KEY=not-a-secret");
        const commits = new FileCommitCoordinator();
        let started!: () => void;
        const ready = new Promise<void>(resolve => {started = resolve;});
        let resume!: () => void;
        const release = new Promise<void>(resolve => {resume = resolve;});
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "scope", enabled: true});
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "shell", {pillarHome: storage.pillarHome}), fileCommits: commits, shellRunner: {
            sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, async run(request) {
                expect(request.filesystemScope?.denyWrite).toContain(join(request.filesystemScope!.root, "node_modules"));
                expect(request.filesystemScope?.denyWrite).toContain(join(request.filesystemScope!.root, ".env"));
                started(); await release;
                return runShellCommand(request);
            }}});
        ctx.fileCheckpoints = runtime;
        await runtime.beginTurn({prompt: "exclusive"});
        const tools = createToolRuntime();
        const shell = tools.executeTool("bash", JSON.stringify({command: "printf checked"}), ctx, "shell");
        await ready;
        const other = tools.executeTool("write_file", JSON.stringify({path: "other", content: "other-session"}), createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "shell", {pillarHome: storage.pillarHome}), fileCommits: commits}), "other");
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(await Bun.file(join(cwd, "other")).exists()).toBe(false);
        resume();
        await Promise.all([shell, other]);
        expect((await runtime.listCheckpoints())[0]?.mutations).toHaveLength(0);
        expect(await Bun.file(join(cwd, "other")).text()).toBe("other-session");
    });
});
