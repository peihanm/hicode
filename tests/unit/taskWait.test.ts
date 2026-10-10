import {expect, spyOn, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {readShellOutputChunk} from "../../src/tasks/managed.js";
import {waitForTaskActivity} from "../../src/tasks/wait.js";
import type {ShellTaskSnapshot, TaskEventEnvelope} from "../../src/tasks/types.js";
import {withTempProject} from "../helpers/tempProject.js";

function fixture() {
    const task: ShellTaskSnapshot = {id: "t_123456789abc", kind: "shell", phase: "running", status: "running",
        timing: {queuedMs: 0, runningMs: 0}, executionMode: "host", owner: {sessionId: "fixture", toolCallId: "start"},
        command: "fixture", cwd: "/fixture", startedAt: new Date().toISOString(), output: ""};
    const listeners = new Set<(event: TaskEventEnvelope) => void>();
    const tasks = {async get() {return task;}, subscribe(listener: (event: TaskEventEnvelope) => void) {
        listeners.add(listener); return () => listeners.delete(listener);
    }};
    let inputSignal: AbortSignal | undefined;
    let sendInput = () => {};
    const input = (signal: AbortSignal) => {
        inputSignal = signal;
        return new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, {once: true});
            sendInput = () => {signal.removeEventListener("abort", abort); resolve();};
        });
    };
    return {task, tasks, listeners, input, get inputSignal() {return inputSignal;}, sendInput: () => sendInput(),
        finish() {task.status = "completed"; for (const listener of listeners) listener({version: 8, sequence: 1, sessionId: "fixture", type: "task_finished", task});}};
}

test("wait window expires normally and cleans both losing subscriptions", async () => {
    const f = fixture();
    const result = await waitForTaskActivity(f.tasks, [f.task.id], new AbortController().signal, "shell", f.input, 5);
    expect(result).toBe("timeout");
    expect(f.task.status).toBe("running");
    expect(f.listeners.size).toBe(0);
    expect(f.inputSignal?.aborted).toBe(true);
});

test.each(["completion", "input", "cancel"] as const)("%s wakes a bounded wait and clears its timer", async mode => {
    const f = fixture();
    const controller = new AbortController();
    const clear = spyOn(globalThis, "clearTimeout");
    try {
        const waiting = waitForTaskActivity(f.tasks, [f.task.id], controller.signal, "shell", f.input, 300_000);
        if (mode === "completion") f.finish();
        if (mode === "input") f.sendInput();
        if (mode === "cancel") controller.abort(new Error("cancelled"));
        if (mode === "cancel") await expect(waiting).rejects.toThrow("cancelled");
        else expect(await waiting).toBe(mode === "completion" ? "task" : "input");
        expect(clear).toHaveBeenCalledTimes(1);
        expect(f.listeners.size).toBe(0);
        expect(f.inputSignal?.aborted).toBe(true);
        if (mode !== "completion") expect(f.task.status).toBe("running");
    } finally {clear.mockRestore();}
});

test("an already completed task returns without waiting and an invalid ID fails closed", async () => {
    const f = fixture();
    f.task.status = "completed";
    expect(await waitForTaskActivity(f.tasks, [f.task.id], new AbortController().signal, "shell", f.input, 300_000)).toBe("task");
    const missing = {...f.tasks, async get() {return undefined;}};
    await expect(waitForTaskActivity(missing, [f.task.id], new AbortController().signal, "shell", f.input, 5)).rejects.toThrow("unavailable");
    expect(f.listeners.size).toBe(0);
});

test("capture cursor distinguishes repeated output and preserves split UTF-8 without unbounded reads", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "capture");
        await writeFile(path, "same\n");
        const first = await readShellOutputChunk(path, 0);
        await writeFile(path, "same\nsame\n");
        const second = await readShellOutputChunk(path, first!.nextOffset);
        expect(second?.content).toBe("same\n");
        expect((await readShellOutputChunk(path, second!.nextOffset))?.content).toBe("");
        const utf8 = Buffer.from("你好");
        await writeFile(path, utf8.subarray(0, 4));
        const split = await readShellOutputChunk(path, 0);
        expect(split).toEqual({nextOffset: 3, content: "你"});
        await writeFile(path, utf8);
        expect(await readShellOutputChunk(path, split!.nextOffset)).toEqual({nextOffset: 6, content: "好"});
        await writeFile(path, "x".repeat(50_000));
        const bounded = await readShellOutputChunk(path, 5);
        expect(bounded?.content).toBe("[First 29995 new bytes omitted]\n" + "x".repeat(20_000));
        expect(bounded?.nextOffset).toBe(50_000);
        await expect(readShellOutputChunk(path, 50_001)).rejects.toThrow("shrank");
        expect(await readShellOutputChunk(join(cwd, "missing"), 0)).toBeUndefined();
    });
});
