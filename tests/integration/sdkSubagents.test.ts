import {expect, test} from "bun:test";
import {mkdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import {createCompactState} from "../../src/context/state.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import type {HiCodeStorageLayout} from "../../src/persistence/index.js";
import {loadSession} from "../../src/session/index.js";
import {createSDKThread} from "../../src/sdk/thread.js";
import {collectTurnResult} from "../../src/sdk/resultCollector.js";
import type {HiCodeHost, InteractionContext, Thread, TurnOptions} from "../../src/sdk/types.js";
import type {InteractionRequest, InteractionResponse, ThreadEvent} from "../../src/sdk/protocol.js";
import {createAgentRunner} from "../../src/agent/runner.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

function latch<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {resolve = done;});
    return {promise, resolve};
}

function resourcesFor(cwd: string, storage: HiCodeStorageLayout, root: ReturnType<typeof createFakeLLM>,
    child: (name: string) => ReturnType<typeof createFakeLLM>, workspaceBoundary = cwd) {
    const compactHistory = async () => ({compacted: false, preTokenCount: 0, threshold: Number.MAX_SAFE_INTEGER});
    return createTestRuntimeResources(cwd, {storage, workspaceBoundary, agentRuntime: {
        runAgent: createAgentRunner({callLLM: root.callLLM, compactHistory}), compactHistory,
        reviewApproval: async () => ({decision: "needs_user", risk: "medium", reason: "Use Host"}),
        reviewTask: async () => {throw new Error("No task review in this fixture");},
        createSubagentThread: (options, request) => createSubagentThreadForTest({
            ...options, toolResultStoreOptions: {hicodeHome: storage.hicodeHome},
            agentOptions: {callLLM: child(request.name ?? "worker").callLLM},
        }, request),
    }});
}

async function open(resources: ReturnType<typeof resourcesFor>, host?: HiCodeHost, allowAgentTasks = true) {
    return createSDKThread({resources, host, allowAgentTasks,
        seed: {sessionId: "sdk-agents", history: createInitialHistory(resources.cwd), compactState: createCompactState()},
        state: {todos: [], permissionMode: "ask", uiEvents: []}, resumed: false, onClose() {},
    });
}

async function run(thread: Thread, input: string, events: ThreadEvent[], options?: TurnOptions) {
    const stream = await thread.runStreamed(input, options);
    async function* observed() {for await (const event of stream.events) {events.push(event); yield event;}}
    return collectTurnResult(observed());
}

test("SDK joins parallel real subagents before the final reply and preserves reports and storage", async () => {
    await withTempProject(async (cwd, storage) => {
        const release = latch(), started = [latch(), latch()];
        const children = [0, 1].map(index => createFakeLLM([async () => {
            started[index]!.resolve();
            await release.promise;
            return assistantText(`child-${index} evidence`);
        }]));
        const first = assistantToolCall("agent", {name: "reader-0", subagent_type: "Explore", description: "first", prompt: "inspect first"}, "spawn-0");
        const second = assistantToolCall("agent", {name: "reader-1", subagent_type: "Explore", description: "second", prompt: "inspect second"}, "spawn-1");
        const root = createFakeLLM([
            {...first, message: {...first.message, tool_calls: [...first.message.tool_calls!, ...second.message.tool_calls!]}},
            async () => {
                await Promise.all(started.map(gate => gate.promise));
                release.resolve();
                return assistantText("Premature final must be discarded");
            },
            ...[0, 1].map(() => (options: Parameters<ReturnType<typeof createFakeLLM>["callLLM"]>[0]) => {
                const text = JSON.stringify(options.messages);
                return assistantText(text.includes("child-0 evidence") && text.includes("child-1 evidence")
                    ? "Integrated both reports" : "Premature final must be discarded");
            }),
        ]);
        const resources = resourcesFor(cwd, storage, root, name => children[name === "reader-0" ? 0 : 1]!);
        const thread = await open(resources);
        const events: ThreadEvent[] = [];
        try {
            const result = await run(thread, "Delegate two independent investigations and combine their reports", events);
            expect(result.finalResponse).toBe("Integrated both reports");
            const items = result.items.filter(item => item.type === "subagent");
            expect(items).toHaveLength(2);
            expect(new Set(items.map(item => item.agentId)).size).toBe(2);
            for (const item of items) {
                expect(item).toMatchObject({status: "completed", taskStatus: "completed", runCount: 1});
                expect(item.transcriptPath).toContain("/subagents/");
                expect(await readFile(item.transcriptPath!, "utf8")).toContain("evidence");
            }
            expect(root.calls.length).toBeGreaterThanOrEqual(3);
            expect(root.calls.length).toBeLessThanOrEqual(4);
            const saved = loadSession(storage, cwd, thread.id)!;
            expect(JSON.stringify(saved.history)).toContain("Integrated both reports");
            expect(saved.history.some(message => message.role === "assistant" && message.content === "Premature final must be discarded")).toBe(false);
        } finally {release.resolve(); await thread.close(); await resources.close();}
    });
});

test.each(["allow", "deny"] as const)("SDK child permissions %s use the current Turn on cross-turn followup", async decision => {
    await withTempProject(async (outer, storage) => {
        const cwd = join(outer, "a"), target = join(outer, "b");
        await mkdir(cwd); await mkdir(target);
        const child = createFakeLLM([
            assistantToolCall("write_file", {path: "first.txt", content: "FIRST"}, "write-first"), assistantText("first report"),
            assistantToolCall("write_file", {path: "second.txt", content: "SECOND"}, "write-second"), assistantText("second report"),
        ]);
        let taskId = "";
        const wait = (options: Parameters<typeof child.callLLM>[0]) => {
            const text = JSON.stringify(options.messages);
            taskId = text.match(/task_id: (t_[a-f0-9]{12})/)![1]!;
            return assistantToolCall("task", {action: "wait", task_id: taskId}, taskId + (text.includes("follow-up assignment") ? "-wait-2" : "-wait-1"));
        };
        const root = createFakeLLM([
            assistantToolCall("agent", {name: "writer", subagent_type: "Worker", description: "write B", prompt: "write first", cwd: target}, "spawn"),
            wait, assistantText("first integrated"),
            () => assistantToolCall("agent_followup", {task_id: taskId, message: "follow-up assignment: write second"}, "followup"),
            wait, assistantText("second integrated"),
        ]);
        const approvals: {request: InteractionRequest; context: InteractionContext}[] = [];
        const resources = resourcesFor(cwd, storage, root, () => child, outer);
        const thread = await open(resources, {onInteraction: async (request, context) => {
            approvals.push({request, context});
            return decision === "allow" ? {behavior: "allow", directoryScope: "once"} : {behavior: "deny", message: "User refused"};
        }});
        try {
            const first = await run(thread, "Create first through a child", []);
            const second = await run(thread, "Give that child another assignment", []);
            expect(approvals).toHaveLength(2);
            expect(approvals.map(entry => entry.context.turnId)).toEqual([first.turnId, second.turnId]);
            expect(approvals.every(entry => entry.request.actor?.agentId === taskId)).toBe(true);
            expect(first.items.filter(item => item.type === "interaction")).toHaveLength(1);
            expect(second.items.filter(item => item.type === "interaction")).toHaveLength(1);
            expect(second.items.find(item => item.type === "subagent")).toMatchObject({agentId: taskId, runCount: 2, taskStatus: "completed"});
            if (decision === "allow") {
                expect(await readFile(join(target, "first.txt"), "utf8")).toBe("FIRST");
                expect(await readFile(join(target, "second.txt"), "utf8")).toBe("SECOND");
            } else {
                await expect(readFile(join(target, "first.txt"))).rejects.toThrow();
                await expect(readFile(join(target, "second.txt"))).rejects.toThrow();
                expect(JSON.stringify(child.calls[1]!.messages)).toContain("User refused");
            }
            expect(JSON.stringify(child.calls[2]!.messages)).toContain("first report");
        } finally {await thread.close(); await resources.close();}
    });
});

test("SDK child failure is collected without a hanging join or fabricated success", async () => {
    await withTempProject(async (cwd, storage) => {
        const child = createFakeLLM([() => {throw new Error("fixture child failure");}]);
        const root = createFakeLLM([
            assistantToolCall("agent", {description: "inspect", prompt: "inspect"}, "spawn"),
            options => assistantToolCall("task", {action: "wait", task_id: JSON.stringify(options.messages).match(/task_id: (t_[a-f0-9]{12})/)![1]!}, "wait"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("fixture child failure");
                return assistantText("Child failed; no successful findings");
            },
        ]);
        const resources = resourcesFor(cwd, storage, root, () => child);
        const thread = await open(resources);
        try {
            const result = await thread.run("Delegate investigation");
            expect(result.items.find(item => item.type === "subagent")).toMatchObject({status: "failed", taskStatus: "failed"});
            expect(result.finalResponse).toContain("Child failed");
        } finally {await thread.close(); await resources.close();}
    });
});

test("SDK queued followup updates one active Item without inventing a failed or interrupted run", async () => {
    await withTempProject(async (cwd, storage) => {
        const started = latch(), release = latch();
        const child = createFakeLLM([
            async () => {started.resolve(); await release.promise; return assistantText("first report");},
            options => {expect(JSON.stringify(options.messages)).toContain("queued followup"); return assistantText("second report");},
        ]);
        let taskId = "";
        const root = createFakeLLM([
            assistantToolCall("agent", {description: "inspect", prompt: "inspect"}, "spawn"),
            async options => {
                await started.promise;
                taskId = JSON.stringify(options.messages).match(/task_id: (t_[a-f0-9]{12})/)![1]!;
                return assistantToolCall("agent_followup", {task_id: taskId, message: "queued followup"}, "queue");
            },
            () => {release.resolve(); return assistantToolCall("task", {action: "wait", task_id: taskId}, "wait");},
            options => {expect(JSON.stringify(options.messages)).toContain("second report"); return assistantText("integrated followup");},
        ]);
        const resources = resourcesFor(cwd, storage, root, () => child);
        const thread = await open(resources);
        try {
            const result = await thread.run("delegate and add work");
            expect(result.items.filter(item => item.type === "subagent")).toEqual([
                expect.objectContaining({agentId: taskId, runCount: 1, status: "completed", taskStatus: "completed", reportPreview: "second report"}),
            ]);
        } finally {release.resolve(); await thread.close(); await resources.close();}
    });
});

test("SDK Root cancellation retains a child's request; Thread.close cancels it and rejects late approval", async () => {
    await withTempProject(async (outer, storage) => {
        const cwd = join(outer, "a"), target = join(outer, "b");
        await mkdir(cwd); await mkdir(target);
        const child = createFakeLLM([assistantToolCall("write_file", {path: "blocked.txt", content: "MUST NOT WRITE"}, "write")]);
        const root = createFakeLLM([
            assistantToolCall("agent", {subagent_type: "Worker", description: "write", prompt: "write", cwd: target}, "spawn"),
            assistantText("premature"),
        ]);
        const request = latch<InteractionContext>(), answer = latch<InteractionResponse>();
        const resources = resourcesFor(cwd, storage, root, () => child, outer);
        const thread = await open(resources, {onInteraction: async (_, context) => {request.resolve(context); return answer.promise;}});
        const controller = new AbortController();
        const events: ThreadEvent[] = [];
        const running = run(thread, "Ask the child to write", events, {signal: controller.signal});
        try {
            const context = await request.promise;
            controller.abort("cancel root only");
            const result = await running;
            expect(result.stopReason).toBe("interrupted");
            expect(context.signal.aborted).toBe(false);
            expect(result.items.find(item => item.type === "interaction")).toMatchObject({status: "interrupted"});
            await thread.close();
            expect(context.signal.aborted).toBe(true);
            expect(resources.taskRuntime.hasRunning()).toBe(false);
            answer.resolve({behavior: "allow", directoryScope: "session"});
            await expect(readFile(join(target, "blocked.txt"))).rejects.toThrow();
            await expect(thread.run("again")).rejects.toMatchObject({code: "thread_closed"});
        } finally {controller.abort(); answer.resolve({behavior: "deny", message: "cleanup"}); await thread.close(); await resources.close(); await running.catch(() => {});}
    });
});

test("one-shot Host can still disable Agent tasks independently", async () => {
    await withTempProject(async (cwd, storage) => {
        const root = createFakeLLM([
            assistantToolCall("agent", {description: "inspect", prompt: "inspect"}, "spawn"),
            options => {expect(JSON.stringify(options.messages)).toContain("does not support Agent tasks"); return assistantText("unavailable");},
        ]);
        let launched = false;
        const resources = resourcesFor(cwd, storage, root, () => {launched = true; return createFakeLLM([]);});
        const thread = await open(resources, undefined, false);
        try {await thread.run("delegate"); expect(launched).toBe(false);}
        finally {await thread.close(); await resources.close();}
    });
});

test.each(["close", "budget"] as const)("SDK %s preserves honest termination and closes a child's live Shell", async mode => {
    await withTempProject(async (cwd, storage) => {
        const ready = latch();
        const child = createFakeLLM([
            assistantToolCall("bash", {command: 'printf "%s" "$$" > child-service-pid; sleep 30', run_in_background: true}, "service"),
            options => {
                expect(JSON.stringify(options.messages)).toMatch(/task_id: t_[a-f0-9]{12}/);
                return assistantToolCall("bash", {command: 'printf "%s" "$$" > child-pid; sleep 30', yield_time_ms: 100}, "finite");
            },
            async options => {
                expect(JSON.stringify(options.messages)).toMatch(/task_id: t_[a-f0-9]{12}/);
                ready.resolve();
                if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), {once: true}));
                return assistantText("cancelled");
            },
        ]);
        const root = createFakeLLM([
            assistantToolCall("agent", {subagent_type: "Worker", description: "run a command", prompt: "run"}, "spawn"),
            assistantText("premature"),
        ]);
        const resources = resourcesFor(cwd, storage, root, () => child);
        const thread = await open(resources);
        const running = thread.run("Delegate a finite command", mode === "budget" ? {maxIterations: 1} : undefined);
        try {
            await ready.promise;
            const pid = Number(await readFile(join(cwd, "child-pid"), "utf8"));
            const servicePid = Number(await readFile(join(cwd, "child-service-pid"), "utf8"));
            expect(pid).toBeGreaterThan(0);
            expect(servicePid).toBeGreaterThan(0);
            if (mode === "budget") {
                const result = await running;
                expect(result.stopReason).toBe("max_turns");
                expect(result.items.find(item => item.type === "subagent")).toMatchObject({status: "failed", taskStatus: "running"});
            }
            await thread.close();
            if (mode === "close") expect((await running).stopReason).toBe("interrupted");
            expect(() => process.kill(pid, 0)).toThrow();
            expect(() => process.kill(servicePid, 0)).toThrow();
            expect(resources.taskRuntime.hasRunning()).toBe(false);
        } finally {await thread.close(); await resources.close(); await running.catch(() => {});}
    });
});
