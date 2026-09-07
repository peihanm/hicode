import {expect, test} from "bun:test";
import {mkdir, readFile, rename, rmdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactState} from "../../src/context/index.js";
import {runTrackedFileWrite} from "../../src/checkpoints/trackedWrite.js";
import {getSessionIndexPath} from "../../src/session/paths.js";
import {getSessionRestorePath} from "../../src/persistence/layout.js";
import {loadSession, saveSessionSnapshot} from "../../src/session/index.js";
import {recoverSessionBeforeStart} from "../../src/checkpoints/rewind.js";

const state = {todos: [], permissionMode: "default", collaborationMode: "build", uiEvents: []} as const;

for (const phase of ["prepared", "files_applied"] as const) for (const externallyChanged of [false, true]) test(`对话提交失败后保留恢复意图（${phase}）；重启${externallyChanged ? "保护外部修改" : "幂等完成"}`, async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage, settings: createTestSettings({checkpointing: {enabled: true}})});
        try {
            const session = createRootSessionRuntime({resources, resumed: false, seed: {sessionId: "recover", history: [], compactState: createCompactState()}});
            await session.beginCheckpoint("change", {...state, permissionMode: "bypassPermissions"});
            const point = session.fileCheckpoints.getHead().checkpointId!;
            const path = join(cwd, "app.txt"); await writeFile(path, "before");
            await runTrackedFileWrite({runtime: session.fileCheckpoints, coordinator: resources.fileCommits, signal: new AbortController().signal,
                path, beforeContent: "before", afterContent: "after", toolCallId: "edit"});
            const second = join(cwd, "second.txt"); await writeFile(second, "before second");
            await runTrackedFileWrite({runtime: session.fileCheckpoints, coordinator: resources.fileCommits, signal: new AbortController().signal,
                path: second, beforeContent: "before second", afterContent: "after second", toolCallId: "edit-second"});
            await session.settleCheckpoint();
            await saveSessionSnapshot(storage, session.createSnapshot({...state, allowEmpty: true}));
            const index = getSessionIndexPath(storage, cwd);
            await rename(index, `${index}.saved`); await mkdir(index);
            const result = await session.restoreCheckpoint(point);
            expect(result.status).toBe("partial");
            expect(await readFile(path, "utf8")).toBe("before");
            expect(await session.fileCheckpoints.getPendingRestore()).toBe(point);
            await rmdir(index); await rename(`${index}.saved`, index);
            if (phase === "prepared") {
                // A persisted fixture represents a crash after only the first file was applied.
                const journalPath = getSessionRestorePath(storage, cwd, "recover");
                const journal = JSON.parse(await readFile(journalPath, "utf8")) as {phase: string};
                journal.phase = "prepared";
                await writeFile(journalPath, JSON.stringify(journal));
                await writeFile(second, "after second");
            }
            if (externallyChanged) {
                await writeFile(path, "outside");
                await expect(recoverSessionBeforeStart(resources, "recover")).rejects.toThrow("冲突");
                expect(await readFile(path, "utf8")).toBe("outside");
                expect(await Bun.file(getSessionRestorePath(storage, cwd, "recover")).exists()).toBe(true);
            } else {
                const restored = await recoverSessionBeforeStart(resources, "recover");
                expect(restored?.permissionMode).toBe("default");
                expect(await readFile(second, "utf8")).toBe("before second");
                expect(restored?.history.filter(message => message.role !== "system")).toEqual([]);
                expect(await Bun.file(getSessionRestorePath(storage, cwd, "recover")).exists()).toBe(false);
                expect(await recoverSessionBeforeStart(resources, "recover")).toBeUndefined();
                const loaded = loadSession(storage, cwd, "recover", resources.model)!;
                const next = createRootSessionRuntime({resources, resumed: true, seed: {...loaded, compactState: createCompactState()}});
                await next.beginCheckpoint("continue", state);
                await next.settleCheckpoint();
            }
        } finally {await resources.close();}
    });
});
