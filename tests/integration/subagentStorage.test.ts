import {expect, test} from "bun:test";
import {mkdir, readFile, readdir, symlink} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {getSessionStorageDirectory, getSubagentStorageDirectory, getProjectSessionsDirectory, sessionStorageId} from "../../src/persistence/layout.js";
import {createSessionPersistence, listSessionIndex, loadSession} from "../../src/session/storage.js";
import {readLatestSessionSnapshot} from "../../src/session/snapshotStore.js";
import {createCompactState} from "../../src/context/state.js";
import {prepareSessionArchive, createSessionArchiveAccess} from "../../src/session/archive.js";
import {checkSessionArchivePath} from "../../src/session/archiveAccess.js";
import {createToolResultStore} from "../../src/toolResults/store.js";
import {createTaskJournal} from "../../src/tasks/journal.js";
import type {Message} from "../../src/llm/types.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";

test("child snapshots and artifacts stay under their parent, while Root resume and sibling access remain isolated", async () => {
    await withTempProject(async (cwd, storage) => {
        const parent = "parent";
        const first = Object.freeze({parentSessionId: parent, agentId: "first"});
        const second = Object.freeze({parentSessionId: parent, agentId: "second"});
        const history: Message[] = [{role: "user", origin: "assignment", content: "private child evidence"}];
        const base = {cwd, model: "qwen3.8-flash", history, todos: [], permissionMode: "ask" as const, allowEmpty: true};
        const rootWriter = createSessionPersistence(storage, cwd, parent);
        await rootWriter.save({...base, sessionId: parent});
        const stores = [createToolResultStore(storage, cwd, parent), createToolResultStore(storage, cwd, first), createToolResultStore(storage, cwd, second)];
        for (const owner of [first, second]) {
            const writer = createSessionPersistence(storage, cwd, owner, "internal");
            await writer.save({...base, sessionId: sessionStorageId(owner)});
            const directory = getSubagentStorageDirectory(storage, cwd, parent, owner.agentId);
            expect(getSessionStorageDirectory(storage, cwd, owner)).toBe(directory);
            expect(await readdir(directory)).toEqual(expect.arrayContaining(["identity.json", "snapshot.json", "content"]));
            const identity = JSON.parse(await readFile(join(directory, "identity.json"), "utf8"));
            expect(identity.sessionId).toBe(sessionStorageId(owner));
            expect(readLatestSessionSnapshot(storage, cwd, owner)?.conversation).toEqual(history);
            expect(loadSession(storage, cwd, sessionStorageId(owner))).toBeNull();
            await expect(writer.save({...base, sessionId: parent})).rejects.toThrow("owner mismatch");
        }
        expect(listSessionIndex(storage, cwd).map(entry => entry.sessionId)).toEqual([parent]);
        expect((await readdir(getProjectSessionsDirectory(storage, cwd))).filter(name => name.startsWith("session-"))).toHaveLength(1);
        const outputs = await Promise.all(stores.map((store, i) => store.persistText({toolCallId: "same-call", toolName: "bash", content: `owner ${i}`})));
        for (let i = 0; i < stores.length; i++) for (let j = 0; j < stores.length; j++) {
            if (i === j) expect((await stores[i]!.resolveFile(outputs[j]!.path))?.resultId).toBe(outputs[j]!.resultId);
            else await expect(stores[i]!.resolveFile(outputs[j]!.path)).rejects.toThrow("unauthorized session");
        }
        // A Root content sweep must not collect the nested child's independent blocks.
        await rootWriter.save({...base, sessionId: parent, history: [{role: "user", origin: "user", content: "new root text"}]});
        expect(readLatestSessionSnapshot(storage, cwd, first)?.conversation).toEqual(history);
    });
});

test("nested archives preserve their capability boundary, including canonical aliases", async () => {
    await withTempProject(async (cwd, storage) => {
        const owner = Object.freeze({parentSessionId: "parent", agentId: "first"});
        const history: Message[] = [{role: "user", origin: "assignment", content: "exact original evidence"}];
        const draft = prepareSessionArchive(storage, cwd, owner, history);
        const state = {...createCompactState(), compactCount: 1, archives: [draft.record]};
        await createSessionPersistence(storage, cwd, owner, "internal").compact({cwd, sessionId: sessionStorageId(owner),
            model: "qwen3.8-flash", history: [{role: "user", origin: "compaction", content: "summary"}],
            compactState: state, todos: [], permissionMode: "ask"}, draft, new AbortController().signal);
        const own = createSessionArchiveAccess(storage, cwd, owner, () => state);
        expect((await own.resolve(draft.indexPath))?.complete).toBe(true);
        expect(await checkSessionArchivePath(storage, draft.indexPath)).toBe(true);
        for (const other of ["parent", {parentSessionId: "parent", agentId: "second"}]) {
            const access = createSessionArchiveAccess(storage, cwd, other, () => state);
            await expect(access.resolve(draft.indexPath)).rejects.toThrow("another Session");
        }
        const alias = join(cwd, "archive-alias.txt");
        await symlink(draft.indexPath, alias);
        await expect(checkSessionArchivePath(storage, alias)).rejects.toThrow("path aliases");
    });
});

test("redirected child directory blocks snapshot, artifact and Task Journal writes before lock creation", async () => {
    await withTempProject(async (cwd, storage) => {
        const owner = Object.freeze({parentSessionId: "parent", agentId: "first"});
        const parent = getSessionStorageDirectory(storage, cwd, "parent");
        const outside = join(cwd, "outside");
        await mkdir(parent, {recursive: true});
        await mkdir(outside);
        await symlink(outside, join(parent, "subagents"));
        const input = {cwd, sessionId: sessionStorageId(owner), model: "qwen3.8-flash", history: [{role: "user" as const, origin: "assignment" as const, content: "test"}], todos: [], permissionMode: "ask" as const, allowEmpty: true};
        await expect(createSessionPersistence(storage, cwd, owner, "internal").save(input)).rejects.toThrow("Unsafe");
        await expect(createToolResultStore(storage, cwd, owner).persistText({toolCallId: "x", toolName: "bash", content: "x"})).rejects.toThrow("Unsafe");
        await expect(createTaskJournal(storage, cwd).load(owner)).rejects.toThrow("Unsafe");
        expect(await readdir(outside)).toEqual([]);
    });
});

test("Task Runtime binds one owner per logical Session and keeps sibling Shell notifications separate", async () => {
    await withTempProject(async (cwd, storage) => {
        const ctx = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, undefined, storage.hicodeHome);
        const first = {parentSessionId: "parent", agentId: "first"};
        const second = {parentSessionId: "parent", agentId: "second"};
        const sessions = [first, second].map(owner => runtime.forSession({sessionId: sessionStorageId(owner), toolResultStore: createToolResultStore(storage, cwd, owner)}));
        try {
            expect(() => runtime.forSession({sessionId: sessionStorageId(first), toolResultStore: createToolResultStore(storage, cwd, {parentSessionId: "different-parent", agentId: "first"})})).toThrow("owner changed");
            expect(() => runtime.forSession({sessionId: "wrong", toolResultStore: createToolResultStore(storage, cwd, first)})).toThrow("owner mismatch");
            const one = await sessions[0]!.runShell({command: "printf first", cwd, toolCallId: "one", signal: ctx.signal, waitMs: 1000, onHandoff() {}});
            expect(one.kind).toBe("inline");
            expect(await sessions[1]!.list()).toEqual([]);
            expect(await sessions[1]!.pendingNotifications()).toEqual([]);
            const journal = createTaskJournal(storage, cwd);
            expect((await journal.load(second)).tasks).toHaveLength(0);
            expect(await readdir(getSubagentStorageDirectory(storage, cwd, "parent", "first"))).toContain("tasks");
            const task = await sessions[0]!.startShell({command: "printf once >> executions.txt", cwd, toolCallId: "background"});
            await waitForTaskCompletion(sessions[0]!, [task.id], ctx.signal, "shell");
            const notification = (await sessions[0]!.pendingNotifications()).find(item => item.taskId === task.id)!;
            expect(notification).toBeDefined();
            await sessions[0]!.acknowledgeNotification(notification);
            expect((await journal.load(first)).claimedNotificationIds.has(notification.notificationId)).toBe(true);
            expect((await journal.load(second)).tasks).toHaveLength(0);
            await runtime.close();
            const restarted = createTaskRuntimeForTest(cwd, ctx.shellRunner, undefined, storage.hicodeHome);
            try {
                const restored = restarted.forSession({sessionId: sessionStorageId(first), toolResultStore: createToolResultStore(storage, cwd, first)});
                expect((await restored.get(task.id))?.status).toBe("completed");
                expect(await restored.pendingNotifications()).toEqual([]);
                expect(await readFile(join(cwd, "executions.txt"), "utf8")).toBe("once");
            } finally {await restarted.close();}
        } finally {await runtime.close();}
    });
});
