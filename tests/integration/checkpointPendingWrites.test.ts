import {expect, test} from "bun:test";
import {chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {getCheckpointDirectory, getCheckpointMutationLogPath} from "../../src/checkpoints/paths.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";

test("项目外多级新目录写入后仍可修改项目文件，重建目录不改变回退身份", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "project");
        await mkdir(cwd);
        await writeFile(join(cwd, "main.js"), "const manualCount = false;");
        const runtime = createFileCheckpointRuntime({storage, cwd, hardBoundary: root, sessionId: "external", enabled: true});
        const point = (await runtime.beginTurn({prompt: "smoke then edit"}))!;
        const ctx = createTestContext(cwd, {workspaceBoundary: root});
        ctx.fileCheckpoints = runtime;
        const tools = createToolRuntime();
        const path = join(root, "scratch", "turn", "smoke.mjs");
        const result = await executeDeliveredTool(tools, "write_file", JSON.stringify({path, content: "export {};"}), ctx, "smoke");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).not.toContain("Checkpoint 警告");
        await executeDeliveredTool(tools, "read_file", JSON.stringify({path: "main.js"}), ctx, "read");
        expect((await executeDeliveredTool(tools, "edit_file", JSON.stringify({path: "main.js", edits: [{old_string: "const", new_string: "let"}]}), ctx, "edit")).outcome).toBe("ok");
        await executeDeliveredTool(tools, "read_file", JSON.stringify({path}), ctx, "read-smoke");
        expect((await executeDeliveredTool(tools, "delete_file", JSON.stringify({path}), ctx, "delete")).outcome).toBe("ok");
        await rm(join(root, "scratch"), {recursive: true});
        expect((await executeDeliveredTool(tools, "write_file", JSON.stringify({path, content: "export const ok = true;"}), ctx, "recreate")).outcome).toBe("ok");
        const [record] = await runtime.listCheckpoints();
        expect(record?.mutations).toHaveLength(2);
        expect(record?.fileCoverage).toBe("complete");
        expect(record?.mutations.every(mutation => !mutation.pending)).toBe(true);
        await runtime.settleTurn();
        expect((await runtime.restoreCode(point.checkpointId)).status).toBe("complete");
        expect(await readFile(join(cwd, "main.js"), "utf8")).toBe("const manualCount = false;");
        await expect(stat(path)).rejects.toMatchObject({code: "ENOENT"});
    });
});

for (const operation of ["create", "edit", "delete"] as const) for (const committed of [false, true]) {
    test(`恢复 ${operation} 的 before-only 记录（committed=${committed}）不重新写入文件`, async () => {
        await withTempProject(async (cwd, storage) => {
            const config = {storage, cwd, sessionId: "pending", enabled: true};
            const runtime = createFileCheckpointRuntime(config);
            const point = (await runtime.beginTurn({prompt: "interrupted write"}))!;
            const path = join(cwd, "file.txt");
            const before = operation === "create" ? null : "before";
            const after = operation === "delete" ? null : "after";
            if (before !== null) await writeFile(path, before);
            expect((await runtime.beforeWrite({path, content: before, afterContent: after, toolCallId: "write"})).captured).toBe(true);
            if (committed) {if (after === null) await rm(path); else await writeFile(path, after);}
            await runtime.markCoverageWarning({code: "checkpoint_after_write_failed", path, message: "after unavailable"});
            await runtime.markCoverageWarning({code: "bash_side_effects", message: "Bash scope"});
            const version = await stat(path).catch(() => null);
            const reopened = createFileCheckpointRuntime({...config, initialHead: runtime.getHead()});
            const links = [{checkpointId: point.checkpointId, branchId: point.branchId}];
            await reopened.reconcileSession(runtime.getHead(), links);
            await reopened.reconcileSession(runtime.getHead(), links);
            const [record] = await reopened.listCheckpoints();
            expect(record?.fileCoverage).toBe("complete");
            expect(record?.coverageWarnings).toEqual([{code: "bash_side_effects", message: "Bash scope"}]);
            expect(record?.mutations).toHaveLength(committed ? 1 : 0);
            const current = await stat(path).catch(() => null);
            expect(current?.ino).toBe(version?.ino);
            expect(current?.mtimeMs).toBe(version?.mtimeMs);
            await reopened.beginTurn({prompt: "continue"});
            await reopened.settleTurn();
            expect((await reopened.restoreCode(point.checkpointId)).status).toBe("complete");
            if (before === null) await expect(stat(path)).rejects.toMatchObject({code: "ENOENT"});
            else expect(await readFile(path, "utf8")).toBe(before);
        });
    });
}

for (const changed of ["content", "mode", "symlink", "parent", "outside"] as const) {
    test(`pending 对账拒绝外部 ${changed} 变化并保留日志`, async () => {
        await withTempProject(async (root, storage) => {
            const cwd = join(root, "project");
            await mkdir(join(cwd, "nested"), {recursive: true});
            const config = {storage, cwd, sessionId: "conflict", enabled: true};
            const runtime = createFileCheckpointRuntime(config);
            const point = (await runtime.beginTurn({prompt: "edit"}))!;
            const path = join(cwd, "nested", "file.txt");
            await writeFile(path, "before");
            await runtime.beforeWrite({path, content: "before", afterContent: "after", toolCallId: "write"});
            await writeFile(path, "after");
            if (changed === "content") await writeFile(path, "external");
            if (changed === "mode") await chmod(path, 0o700);
            if (changed === "symlink") {
                await writeFile(join(cwd, "target.txt"), "after");
                await rm(path); await symlink(join(cwd, "target.txt"), path);
            }
            if (changed === "parent" || changed === "outside") {
                const target = join(changed === "parent" ? cwd : root, "redirect");
                await mkdir(target); await writeFile(join(target, "file.txt"), "after");
                await rm(join(cwd, "nested"), {recursive: true}); await symlink(target, join(cwd, "nested"));
            }
            const journal = getCheckpointMutationLogPath(getCheckpointDirectory(storage, cwd, "conflict"), point.checkpointId);
            const original = await readFile(journal, "utf8");
            const reopened = createFileCheckpointRuntime({...config, initialHead: runtime.getHead()});
            await expect(reopened.reconcileSession(runtime.getHead(), [{checkpointId: point.checkpointId, branchId: point.branchId}])).rejects.toThrow("写入对账失败");
            expect(await readFile(journal, "utf8")).toBe(original);
            expect(await readFile(path, "utf8")).toBe(changed === "content" ? "external" : "after");
            await expect(reopened.beginTurn({prompt: "next"})).rejects.toThrow(join(await realpath(cwd), "nested", "file.txt"));
        });
    });
}

test("未验证 Session 关联时不得对 pending 追加完成记录", async () => {
    await withTempProject(async (cwd, storage) => {
        const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "unlinked", enabled: true});
        await runtime.beginTurn({prompt: "write"});
        const path = join(cwd, "file.txt");
        await runtime.beforeWrite({path, content: null, afterContent: "after", toolCallId: "write"});
        await writeFile(path, "after");
        await expect(runtime.reconcileSession(runtime.getHead(), [])).rejects.toThrow("Session turn checkpoint");
        expect((await runtime.listCheckpoints())[0]?.mutations[0]?.pending).toBeDefined();
    });
});

test("恢复曾以父目录为 root 的 pending 后，后续写入仍归属同一文件", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "project"); await mkdir(cwd);
        const parent = join(root, "scratch"); await mkdir(parent);
        const path = join(parent, "file.txt");
        const config = {storage, cwd, hardBoundary: root, sessionId: "root-identity", enabled: true};
        const runtime = createFileCheckpointRuntime(config);
        const point = (await runtime.beginTurn({prompt: "write"}))!;
        await runtime.beforeWrite({path, content: null, afterContent: "after", toolCallId: "first"});
        const journal = getCheckpointMutationLogPath(getCheckpointDirectory(storage, cwd, config.sessionId), point.checkpointId);
        const event = JSON.parse(await readFile(journal, "utf8"));
        await writeFile(journal, JSON.stringify({...event, root: await realpath(parent), path: "file.txt"}) + "\n");
        await writeFile(path, "after");
        await runtime.reconcileSession(runtime.getHead(), [{checkpointId: point.checkpointId, branchId: point.branchId}]);
        expect((await runtime.beforeWrite({path, content: "after", afterContent: "next", toolCallId: "second"})).captured).toBe(true);
        await writeFile(path, "next");
        expect((await runtime.afterWrite({path, content: "next", toolCallId: "second"})).captured).toBe(true);
        expect((await runtime.listCheckpoints())[0]?.mutations).toHaveLength(1);
        expect((await runtime.restoreCode(point.checkpointId)).status).toBe("complete");
        await expect(stat(path)).rejects.toMatchObject({code: "ENOENT"});
    });
});
