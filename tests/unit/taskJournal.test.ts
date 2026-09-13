import {decodeTaskJournalEntry} from "../../src/tasks/codec.js";
import {describe, expect, test} from "bun:test";
import {appendFile, readFile} from "node:fs/promises";
import {join} from "node:path";
import {createPillarStorageLayout, getSessionStorageDirectory} from "../../src/persistence/index.js";
import {createTaskJournal} from "../../src/tasks/journal.js";
import {taskNotificationId, TaskNotificationCenter} from "../../src/tasks/notifications.js";
import type {TaskEventEnvelope} from "../../src/tasks/types.js";
import {withTempProject} from "../helpers/tempProject.js";

function shellEvent(input: {
    sequence: number;
    sessionId?: string;
    ownerSessionId?: string;
    taskId?: string;
    type?: TaskEventEnvelope["type"];
    status?: "running" | "completed";
}): TaskEventEnvelope {
    const sessionId = input.sessionId ?? "session-a";
    const status = input.status ?? "running";
    return {
        version: 5,
        type: input.type ?? "task_progress",
        sequence: input.sequence,
        sessionId,
        task: {
            id: input.taskId ?? "task-a",
            kind: "shell", executionMode: "sandbox",
            owner: {
                sessionId: input.ownerSessionId ?? sessionId,
                toolCallId: "call-a",
            },
            command: "fixture",
            cwd: "/tmp/project",
            status,
            startedAt: "2026-08-30T00:00:00.000Z",
            ...(status === "completed"
                ? {completedAt: "2026-08-30T00:00:01.000Z"}
                : {}),
            output: "",
        },
    };
}

function pathFor(
    storage: ReturnType<typeof createPillarStorageLayout>,
    cwd: string,
    sessionId = "session-a"
): string {
    return join(
        getSessionStorageDirectory(storage, cwd, sessionId),
        "tasks",
        "events.jsonl"
    );
}

describe("TaskJournal", () => {
    test("拒绝跨 Session owner，并恢复 spawn_error 的 Error message", async () => {
        await withTempProject(async (cwd) => {
            const storage = createPillarStorageLayout({pillarHome: join(cwd, "store")});
            const journal = createTaskJournal(storage, cwd);
            await expect(journal.append(shellEvent({
                sequence: 1,
                ownerSessionId: "other-session",
            }))).rejects.toThrow("Refusing to persist invalid");

            const event = shellEvent({
                sequence: 2,
                type: "task_finished",
                status: "completed",
            });
            if (event.task.kind !== "shell") throw new Error("invalid fixture");
            event.task.termination = {
                kind: "spawn_error",
                error: new Error("spawn failed"),
            };
            event.task.status = "failed";
            await journal.append(event);

            const restored = await createTaskJournal(storage, cwd).load("session-a");
            const task = restored.tasks[0];
            expect(task?.kind).toBe("shell");
            if (task?.kind !== "shell" || task.termination?.kind !== "spawn_error") {
                throw new Error("spawn_error 未恢复");
            }
            expect(task.termination.error).toBeInstanceOf(Error);
            expect(task.termination.error.message).toBe("spawn failed");
        });
    });

    test("下次 append 原子修复崩溃留下的未终止尾行", async () => {
        await withTempProject(async (cwd) => {
            const storage = createPillarStorageLayout({pillarHome: join(cwd, "store")});
            const journal = createTaskJournal(storage, cwd);
            await journal.append(shellEvent({sequence: 1, taskId: "task-a"}));
            await appendFile(pathFor(storage, cwd), "{\"partial\"");
            await journal.append(shellEvent({sequence: 2, taskId: "task-b"}));

            const content = await readFile(pathFor(storage, cwd), "utf8");
            expect(content).not.toContain("partial");
            expect((await journal.load("session-a")).tasks).toHaveLength(2);
        });
    });

    test("完整坏行 fail closed，不把新事件追加到不可恢复日志后面", async () => {
        await withTempProject(async (cwd) => {
            const storage = createPillarStorageLayout({pillarHome: join(cwd, "store")});
            const journal = createTaskJournal(storage, cwd);
            await journal.append(shellEvent({sequence: 1}));
            await appendFile(pathFor(storage, cwd), "{bad-json}\n");

            await expect(journal.load("session-a")).rejects.toThrow("corrupt records");
            await expect(journal.append(shellEvent({sequence: 2})))
                .rejects.toThrow("corrupt records");
            expect(await readFile(pathFor(storage, cwd), "utf8"))
                .not.toContain('"sequence":2');
        });
    });

    test("高频 progress 会压缩为任务最新状态", async () => {
        await withTempProject(async (cwd) => {
            const storage = createPillarStorageLayout({pillarHome: join(cwd, "store")});
            const journal = createTaskJournal(storage, cwd);
            await journal.append(shellEvent({
                sequence: 1,
                type: "task_started",
            }));
            for (let sequence = 2; sequence <= 1_024; sequence++) {
                await journal.append(shellEvent({sequence}));
            }

            const lines = (await readFile(pathFor(storage, cwd), "utf8"))
                .trim().split("\n");
            expect(lines).toHaveLength(1);
            const loaded = await journal.load("session-a");
            expect(loaded.sequence).toBe(1_024);
            expect(loaded.tasks).toHaveLength(1);
        });
    });

    test("压缩保留旧轮次未交付终态，新轮次 ACK 不会抹掉旧结果", async () => {
        await withTempProject(async cwd => {
            const storage = createPillarStorageLayout({pillarHome: join(cwd, "store")});
            const journal = createTaskJournal(storage, cwd);
            for (const runCount of [1, 2]) {
                await journal.append({version: 5, type: "task_finished", sequence: runCount, sessionId: "session-a",
                    task: {id: "agent-a", kind: "agent", cwd, owner: {sessionId: "session-a", toolCallId: "call"},
                        agentType: "Explore", description: "test", status: "completed", startedAt: "2026-09-05T00:00:00.000Z",
                        completedAt: "2026-09-05T00:00:01.000Z", resultPreview: `run ${runCount}`,
                        progress: {runCount, iterations: 1, toolUseCount: 0, pendingMessages: 0}}});
            }
            await journal.markNotificationClaimed({sequence: 3, sessionId: "session-a", taskId: "agent-a",
                notificationId: taskNotificationId("agent-a", 2)});
            for (let sequence = 4; sequence <= 1_024; sequence++) await journal.append(shellEvent({sequence}));
            const loaded = await createTaskJournal(storage, cwd).load("session-a");
            expect(loaded.tasks.find(task => task.id === "agent-a")).toMatchObject({progress: {runCount: 2}});
            expect(loaded.pendingRuns).toEqual([expect.objectContaining({resultPreview: "run 1"})]);
            await journal.markNotificationClaimed({sequence: 1_025, sessionId: "session-a", taskId: "agent-a",
                notificationId: taskNotificationId("agent-a", 1)});
            expect((await journal.load("session-a")).pendingRuns).toEqual([]);
        });
    });

    test("archived pending 只由显式 ACK 清除", () => {
        const center = new TaskNotificationCenter();
        center.rememberArchived("task-a", false);
        expect(center.hasArchivedPending("task-a")).toBe(true);
        center.acknowledgeArchived("task-a");
        expect(center.hasArchivedPending("task-a")).toBe(false);
    });
});

test("interrupted is an Agent-only persisted status", () => {
    const shell = shellEvent({sequence: 1, status: "completed", type: "task_finished"});
    expect(decodeTaskJournalEntry({...shell, task: {...shell.task, status: "interrupted"}}, "session-a")).toBeUndefined();
    const agent = {...shell, task: {id: "agent-id", kind: "agent", owner: shell.task.owner, cwd: "/tmp/project",
        agentType: "Worker", description: "work", status: "interrupted", startedAt: "2026-08-30T00:00:00.000Z", completedAt: "2026-08-30T00:00:01.000Z",
        reason: "interrupted", progress: {runCount: 1, iterations: 1, toolUseCount: 1, pendingMessages: 0}}};
    expect(decodeTaskJournalEntry(agent, "session-a")?.type).toBe("task_finished");
});
