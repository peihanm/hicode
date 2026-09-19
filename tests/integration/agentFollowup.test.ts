import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {expect, test, setSystemTime} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import type {TaskSessionLike, TaskEventEnvelope} from "../../src/tasks/types.js";
import {agentRunTiming} from "../../src/tasks/timing.js";
import {decodeTaskJournalEntry} from "../../src/tasks/codec.js";
import {describeToolCall} from "../../src/tools/presentation.js";

function finished(tasks: TaskSessionLike): Promise<void> {
    return new Promise(resolve => {
        const unsubscribe = tasks.subscribe(event => {if (event.type === "task_finished") {unsubscribe(); resolve();}});
    });
}
const request = {agentType: "Worker", name: "board", description: "Board logic", prompt: "Implement", parentToolCallId: "spawn"};
const todo = {content: "Check board", activeForm: "Checking board", status: "in_progress"};

test("followup has a strict standalone tool, respects ownership and never relaunches on invalid input", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd, {canUseTool: async () => {throw new Error("No additional approval needed");}});
        let runs = 0;
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, options => ({agentId: options.agentId, async run() {
            runs++;
            return {agentId: options.agentId, agentType: "Worker", description: "Board logic", reply: "done", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 0};
        }}));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        parent.tasks = tasks;
        try {
            const done = finished(tasks);
            const task = await tasks.startAgent({request, parentContext: parent});
            await done;
            for (const args of [{message: "next"}, {target: task.id}, {task_id: task.id, message: "next"}, {target: task.id, message: " "}, {target: task.id, message: "界".repeat(12000)}]) {
                expect((await executeToolResult("agent_followup", JSON.stringify(args), parent, "bad-input")).outcome).not.toBe("ok");
            }
            expect((await executeToolResult("task", JSON.stringify({action: "followup", task_id: task.id, message: "next"}), parent, "old-tool")).outcome).not.toBe("ok");
            const stranger = createTestContext(cwd, {sessionId: "stranger"});
            stranger.tasks = runtime.forSession({sessionId: stranger.sessionId, toolResultStore: stranger.toolResultStore});
            expect((await executeToolResult("agent_followup", JSON.stringify({target: task.id, message: "next"}), stranger, "wrong-owner")).outcome).toBe("denied");
            const restrictedCwd = join(cwd, "restricted");
            await mkdir(restrictedCwd);
            const restricted = createTestContext(restrictedCwd);
            restricted.tasks = tasks;
            expect((await executeToolResult("agent_followup", JSON.stringify({target: task.id, message: "next"}), restricted, "outside-directory")).outcome).toBe("denied");
            parent.permissionRules.deny.push({toolName: "agent_followup", source: "host"});
            expect((await executeToolResult("agent_followup", JSON.stringify({target: task.id, message: "next"}), parent, "explicit-deny")).outcome).toBe("denied");
            parent.permissionRules.deny.pop();
            expect(runs).toBe(1);
            const nextDone = finished(tasks);
            const reply = await executeToolResult("agent_followup", JSON.stringify({target: task.id, message: "next"}), parent, "valid");
            expect(reply.outcome).toBe("ok");
            expect(reply.modelContent).toContain("Agent continued: board");
            expect(reply.modelContent).toContain("Run: 2");
            await nextDone;
            expect(runs).toBe(2);
            await tasks.stop(task.id);
            expect((await executeToolResult("agent_followup", JSON.stringify({target: task.id, message: "next"}), parent, "stopped")).outcome).not.toBe("ok");
            expect(runs).toBe(2);
            expect(describeToolCall("agent_followup", JSON.stringify({target: task.id}))).toEqual({label: "Continue Agent", detail: task.id});
        } finally {await runtime.close();}
    });
});

test("per-run time excludes idle gaps, queued work keeps the clock, and journal retains both durations", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const entered = gates.map(() => Promise.withResolvers<void>());
        let runs = 0;
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, options => ({agentId: options.agentId, async run() {
            const index = runs++;
            entered[index]!.resolve();
            await gates[index]!.promise;
            return {agentId: options.agentId, agentType: "Worker", description: "Board logic", reply: "done", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 0};
        }}));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        const base = Date.parse("2026-09-19T00:00:00.000Z");
        const time = (seconds: number) => setSystemTime(new Date(base + seconds * 1000));
        try {
            time(0);
            let done = finished(tasks);
            const task = await tasks.startAgent({request, parentContext: parent});
            await entered[0]!.promise;
            time(10); gates[0]!.resolve(); await done;
            time(110);
            done = finished(tasks);
            const {task: next} = await tasks.followup(task.id, "second");
            expect(next.progress).toMatchObject({runCount: 2, runStartedAt: new Date(base + 110000).toISOString(), previousDurationMs: 10000});
            await entered[1]!.promise;
            time(115);
            const {task: queued, delivery} = await tasks.followup(task.id, "third");
            expect(delivery).toBe("queued");
            expect(queued.progress.runStartedAt).toBe(next.progress.runStartedAt);
            expect(queued.progress.runCount).toBe(2);
            expect(agentRunTiming(queued)).toEqual({runMs: 5000, totalMs: 15000});
            time(130); gates[1]!.resolve(); await entered[2]!.promise;
            time(135); gates[2]!.resolve(); await done;
            const result = await tasks.get(task.id);
            if (!result || result.kind !== "agent") throw new Error("Missing Agent");
            expect(result.progress.runCount).toBe(3);
            expect(result.startedAt).toBe(task.startedAt);
            expect(agentRunTiming(result)).toEqual({runMs: 5000, totalMs: 35000});
            const envelope: TaskEventEnvelope = {version: 6, type: "task_finished", sequence: 1, sessionId: parent.sessionId, task: result};
            const decoded = decodeTaskJournalEntry(JSON.parse(JSON.stringify(envelope)), parent.sessionId);
            expect(decoded).toEqual(envelope);
            for (const progress of [{...result.progress, previousDurationMs: -1}, {...result.progress, runStartedAt: "bad"}, {...result.progress, todosUpdated: "yes"}]) {
                expect(decodeTaskJournalEntry({...envelope, task: {...result, progress}}, parent.sessionId)).toBeUndefined();
            }
        } finally {for (const gate of gates) gate.resolve(); await runtime.close(); setSystemTime();}
    });
});

test("completed plans stay in history while new runs report no Todo update until the tool actually runs", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const fake = createFakeLLM([
            assistantToolCall("todo_write", {todos: [todo]}, "plan"),
            assistantToolCall("todo_write", {todos: [{...todo, status: "completed"}]}, "done"),
            assistantText("First report"),
            options => {
                const text = JSON.stringify(options.messages);
                expect(text).toContain("First report");
                expect(text).toContain("Worker run 2: continuation");
                expect(text).toContain("Todo updated this run: no");
                expect(text).not.toContain("The unfinished plan is carried forward");
                return assistantText("Quick answer, no Todo needed");
            },
        ]);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, (options, input) => createSubagentThreadForTest({...options, agentOptions: {callLLM: fake.callLLM}}, input));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        try {
            let done = finished(tasks);
            const task = await tasks.startAgent({request, parentContext: parent});
            await done;
            expect(await tasks.get(task.id)).toMatchObject({progress: {todosUpdated: true, todos: []}});
            done = finished(tasks);
            await tasks.followup(task.id, "One quick question"); await done;
            const result = await tasks.get(task.id);
            expect(result).toMatchObject({status: "completed", progress: {runCount: 2, todosUpdated: false}});
            if (!result || result.kind !== "agent") throw new Error("Missing Agent");
            expect(result.progress.todos).toBeUndefined();
        } finally {await runtime.close();}
    });
});

test("concurrent followups reserve one run and queue the other without overlapping the thread", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        let active = 0, maximum = 0, runs = 0;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, options => ({agentId: options.agentId, async run() {
            const current = ++runs;
            maximum = Math.max(maximum, ++active);
            if (current === 2) {entered.resolve(); await release.promise;}
            active--;
            return {agentId: options.agentId, agentType: "Worker", description: "Board logic", reply: "done", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 0};
        }}));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        try {
            let done = finished(tasks);
            const task = await tasks.startAgent({request, parentContext: parent}); await done;
            done = finished(tasks);
            const replies = await Promise.all([tasks.followup(task.id, "A"), tasks.followup(task.id, "B")]);
            await entered.promise;
            expect(replies.every(reply => reply.task.progress.runCount === 2)).toBe(true);
            expect(replies.map(reply => reply.delivery).sort()).toEqual(["queued", "started"]);
            release.resolve(); await done;
            expect(maximum).toBe(1);
            expect(runs).toBe(3);
        } finally {release.resolve(); await runtime.close();}
    });
});
