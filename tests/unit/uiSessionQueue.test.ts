import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {createSessionPersistence, loadSession} from "../../src/session/storage.js";
import {getSessionIndexPath} from "../../src/session/paths.js";
import {withTempProject} from "../helpers/tempProject.js";
import {SESSION_INDEX_VERSION, type SaveSessionSnapshotInput} from "../../src/session/types.js";

test("Session 串行捕获输入数组，不被后续 Host 更新改变；保存失败后可继续", async () => {
    await withTempProject(async (cwd, storage) => {
        const writer = createSessionPersistence(storage, cwd, "queue");
        const input: SaveSessionSnapshotInput = {cwd, sessionId: "queue", model: "glm-test",
            history: [{role: "user", origin: "user", content: "original"}], todos: [], permissionMode: "ask", collaborationMode: "build",
            toolDiscovery: {version: 2, loadedNames: ["first"]}};
        const first = writer.save(input);
        input.history[0] = {role: "user", origin: "user", content: "next"};
        input.toolDiscovery!.loadedNames[0] = "second";
        await first;
        expect(loadSession(storage, cwd, "queue", "glm-test")?.history.at(-1)?.content).toBe("original");
        expect(loadSession(storage, cwd, "queue", "glm-test")?.toolDiscovery?.loadedNames).toEqual(["first"]);
        await writeFile(getSessionIndexPath(storage, cwd), "invalid index");
        await expect(writer.save(input)).rejects.toThrow("corrupt session index");
        await writeFile(getSessionIndexPath(storage, cwd), JSON.stringify({version: SESSION_INDEX_VERSION, sessions: []}));
        await writer.save(input);
        await writer.drain();
        expect(loadSession(storage, cwd, "queue", "glm-test")?.history.at(-1)?.content).toBe("next");
    });
});

test("半批次只保存通知收据和队列，不覆盖完整正文，也不冻结执行中的结果", async () => {
    await withTempProject(async (cwd, storage) => {
        const writer = createSessionPersistence(storage, cwd, "metadata");
        const input: SaveSessionSnapshotInput = {cwd, sessionId: "metadata", model: "glm-test",
            history: [{role: "user", origin: "user", content: "original"}], todos: [], permissionMode: "ask", collaborationMode: "build"};
        await writer.save(input);
        const pending = {role: "assistant" as const, content: null, tool_calls: [{id: "pending", type: "function" as const, function: {name: "write_file", arguments: "{}"}}]};
        const receipt = "a".repeat(64);
        await writer.save({...input, history: [...input.history, pending], taskNotificationReceipts: [receipt],
            queuedInputs: [{id: receipt, type: "task_notification", taskId: "task", priority: "next", content: "completed", createdAt: new Date().toISOString()}]});
        const loaded = loadSession(storage, cwd, "metadata", "glm-test")!;
        expect(loaded.history.filter(message => message.role === "assistant")).toHaveLength(0);
        expect(loaded.taskNotificationReceipts).toEqual([receipt]);
        expect(loaded.queuedInputs).toHaveLength(1);
        expect(Object.isFrozen(pending)).toBe(false);
        await writer.save({...input, history: [...input.history, pending, {role: "tool", tool_call_id: "pending", content: "done"}],
            taskNotificationReceipts: [receipt], queuedInputs: []});
        const final = loadSession(storage, cwd, "metadata", "glm-test")!;
        expect(final.history.filter(message => message.role === "tool")).toHaveLength(1);
        expect(final.queuedInputs).toHaveLength(0);
    });
});
