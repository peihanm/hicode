import {expect, test} from "bun:test";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {createFakeLLM, assistantText, assistantToolCall} from "../helpers/fakeLLM.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {TaskSessionLike} from "../../src/tasks/types.js";
import type {Message} from "../../src/llm/types.js";

function finished(tasks: TaskSessionLike): Promise<void> {
    return new Promise(resolve => {
        const unsubscribe = tasks.subscribe(event => {
            if (event.type === "task_finished") {unsubscribe(); resolve();}
        });
    });
}

function expectPaired(history: readonly Message[]) {
    for (const message of history) {
        if (message.role !== "assistant") continue;
        for (const call of message.tool_calls ?? []) {
            expect(history.filter(item => item.role === "tool" && item.tool_call_id === call.id)).toHaveLength(1);
        }
    }
}

const request = {agentType: "Worker", description: "bounded work", prompt: "do the work", parentToolCallId: "spawn", readOnly: true};

test("background worker exchanges bounded messages through tools; idle messages do not launch work", async () => {
    await withTempProject(async cwd => {
        const inbox = new RuntimeMessageQueue();
        const parent = createTestContext(cwd);
        const child = createFakeLLM([
            options => {
                const names = options.tools.map(tool => tool.function.name);
                expect(names).toContain("agent_message");
                expect(names).toContain("task");
                expect(JSON.stringify(options.tools.find(tool => tool.function.name === "task")?.function.parameters)).not.toContain("followup");
                expect(names).not.toContain("agent");
                expect(JSON.stringify(options.messages)).toContain("restricted to read-only tools");
                const send = assistantToolCall("agent_message", {action: "send", target: "parent", message: "Which interface?"}, "child-send");
                const wait = assistantToolCall("agent_message", {action: "wait", timeout_ms: 1000}, "child-wait");
                const calls = [...send.toolCalls, ...wait.toolCalls];
                return {...send, message: {...send.message, tool_calls: calls}, toolCalls: calls};
            },
            options => {
                expectPaired(options.messages);
                expect(options.messages.find(item => item.role === "user" && typeof item.content === "string" && item.content.includes("Use interface A")))
                    .toMatchObject({origin: "agent"});
                return assistantText("Implemented interface A");
            },
            options => {
                expectPaired(options.messages);
                for (const text of ["An idle note", "Now check the interface"]) {
                    expect(options.messages.find(item => item.role === "user" && typeof item.content === "string" && item.content.includes(text))).toMatchObject({origin: "agent"});
                }
                expect(JSON.stringify(options.messages)).toContain("An idle note");
                expect(JSON.stringify(options.messages)).toContain("Now check the interface");
                expect(JSON.stringify(options.messages)).toContain("Implemented interface A");
                return assistantText("Checked interface A");
            },
        ]);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner,
            (options, input) => createSubagentThreadForTest({...options, agentOptions: {callLLM: child.callLLM}}, input));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore, messageQueue: inbox});
        parent.tasks = tasks;
        parent.agentMessaging = tasks.messaging;
        try {
            const done = finished(tasks);
            const started = await tasks.startAgent({request, parentContext: parent});
            expect(await inbox.waitForAgentMessage(1000, new AbortController().signal)).toBe("message");
            expect(inbox.list()[0]).toMatchObject({type: "agent_message", route: {sender: started.id, recipient: "parent", runCount: 1, intent: "message"}});
            const sent = await executeToolResult("agent_message", JSON.stringify({action: "send", target: started.id, message: "Use interface A"}), parent, "parent-send");
            expect(sent.outcome).toBe("ok");
            await done;
            expect(await tasks.get(started.id)).toMatchObject({status: "completed", resultPreview: "Implemented interface A"});
            await parent.agentMessaging!.send(started.id, "An idle note");
            expect(await tasks.get(started.id)).toMatchObject({status: "completed", progress: {runCount: 1, pendingMessages: 1}});
            expect(child.calls).toHaveLength(2);
            const nextDone = finished(tasks);
            const continued = await executeToolResult("task", JSON.stringify({action: "followup", task_id: started.id, message: "Now check the interface"}), parent, "followup");
            expect(continued.outcome).toBe("ok");
            await nextDone;
            expect(await tasks.get(started.id)).toMatchObject({status: "completed", progress: {runCount: 2, pendingMessages: 0}});
            await tasks.stop(started.id);
            await expect(tasks.followup(started.id, "restart")).rejects.toThrow("cancelled");
            await expect(parent.agentMessaging!.send(started.id, "restart")).rejects.toThrow("stopped");
        } finally {await runtime.close();}
    });
});

test("interrupt cancels a tool batch, pairs its result and permits continuation of the same history", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const child = createFakeLLM([
            () => assistantToolCall("agent_message", {action: "wait", timeout_ms: 60000}, "wait-for-parent"),
            options => {
                expectPaired(options.messages);
                expect(JSON.stringify(options.messages)).toContain("wait-for-parent");
                expect(JSON.stringify(options.messages)).toContain("Continue after interruption");
                return assistantText("continued successfully");
            },
        ]);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner,
            (options, input) => createSubagentThreadForTest({...options, agentOptions: {callLLM: child.callLLM}}, input));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore, messageQueue: new RuntimeMessageQueue()});
        parent.tasks = tasks;
        const waiting = new Promise<void>(resolve => {
            const unsubscribe = tasks.subscribe(event => {
                if (event.task.kind === "agent" && event.task.progress.lastActivity === "agent_message") {unsubscribe(); resolve();}
            });
        });
        try {
            const started = await tasks.startAgent({request, parentContext: parent});
            await waiting;
            const result = await executeToolResult("task", JSON.stringify({action: "interrupt", task_id: started.id}), parent, "interrupt");
            expect(result.outcome).toBe("ok");
            expect(await tasks.get(started.id)).toMatchObject({status: "interrupted", progress: {runCount: 1}});
            expect((await tasks.pendingNotifications()).some(item => item.status === "interrupted")).toBe(true);
            const done = finished(tasks);
            await tasks.followup(started.id, "Continue after interruption");
            await done;
            expect(await tasks.get(started.id)).toMatchObject({status: "completed", progress: {runCount: 2}, resultPreview: "continued successfully"});
        } finally {await runtime.close();}
    });
});

test("child cannot message siblings, and root cannot address another session's agent", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        const child = createFakeLLM([
            () => assistantToolCall("agent_message", {action: "send", target: "00000000-0000-0000-0000-000000000000", message: "not allowed"}, "sibling"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("only its parent");
                return assistantText("scope enforced");
            },
        ]);
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner,
            (options, input) => createSubagentThreadForTest({...options, agentOptions: {callLLM: child.callLLM}}, input));
        const inbox = new RuntimeMessageQueue();
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore, messageQueue: inbox});
        const other = runtime.forSession({sessionId: "other-session", toolResultStore: parent.toolResultStore, messageQueue: new RuntimeMessageQueue()});
        try {
            const done = finished(tasks);
            const started = await tasks.startAgent({request, parentContext: parent});
            await done;
            expect(await tasks.get(started.id)).toMatchObject({status: "completed", resultPreview: "scope enforced"});
            expect(inbox.list()).toHaveLength(0);
            await expect(other.messaging!.send(started.id, "cross-session")).rejects.toThrow("not found");
            await expect(other.interrupt(started.id)).rejects.toThrow("live-session Agent");
        } finally {await runtime.close();}
    });
});

test.each(["stop", "shutdown"] as const)("%s wins over an in-flight interrupt and pending followup", async action => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {release = resolve;});
        let startedRun!: () => void;
        const running = new Promise<void>(resolve => {startedRun = resolve;});
        let sawAbort!: () => void;
        const abortSeen = new Promise<void>(resolve => {sawAbort = resolve;});
        let calls = 0;
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, options => ({
            agentId: options.agentId,
            async run(input) {
                calls++;
                startedRun();
                if (!input.signal.aborted) await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), {once: true}));
                sawAbort();
                await gate;
                return {agentId: options.agentId, agentType: "Worker", description: "race", reply: "cancelled work", reason: "interrupted", iterations: 1, toolUseCount: 0, durationMs: 1};
            },
        }));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        try {
            const task = await tasks.startAgent({request, parentContext: parent});
            await running;
            const interruption = tasks.interrupt(task.id);
            await abortSeen;
            const followup = tasks.followup(task.id, "do not restart after closure").then(() => "unexpected continuation", error => String(error));
            const closing = action === "stop" ? tasks.stop(task.id) : runtime.close();
            release();
            await Promise.all([interruption, closing]);
            expect(await followup).toMatch(/cancelled|closed/);
            expect(await tasks.get(task.id)).toMatchObject({status: "cancelled", progress: {runCount: 1}});
            expect(calls).toBe(1);
        } finally {release(); await runtime.close();}
    });
});

test("followup arriving during interruption waits for the run to settle before restarting", async () => {
    await withTempProject(async cwd => {
        const parent = createTestContext(cwd);
        let started!: () => void;
        const running = new Promise<void>(resolve => {started = resolve;});
        let release!: () => void;
        const gate = new Promise<void>(resolve => {release = resolve;});
        let calls = 0, active = 0, maxActive = 0;
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, options => ({
            agentId: options.agentId,
            async run(input) {
                const run = ++calls;
                maxActive = Math.max(maxActive, ++active);
                if (run === 1) {
                    started();
                    if (!input.signal.aborted) await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), {once: true}));
                    await gate;
                }
                active--;
                return {agentId: options.agentId, agentType: "Worker", description: "race", reply: input.prompt,
                    reason: run === 1 ? "interrupted" : "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
            },
        }));
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
        try {
            const task = await tasks.startAgent({request, parentContext: parent});
            await running;
            const interruption = tasks.interrupt(task.id);
            const continuation = tasks.followup(task.id, "next run");
            release();
            await interruption;
            const done = finished(tasks);
            await continuation;
            await done;
            expect(await tasks.get(task.id)).toMatchObject({status: "completed", progress: {runCount: 2}});
            expect(calls).toBe(2);
            expect(maxActive).toBe(1);
        } finally {release(); await runtime.close();}
    });
});
