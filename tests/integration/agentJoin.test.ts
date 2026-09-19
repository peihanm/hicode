import {expect, test} from "bun:test";
import type {Message} from "../../src/llm/types.js";
import {AgentTaskJoin, waitForAgentTasks} from "../../src/tasks/agentJoin.js";
import type {ApprovalEvent} from "../../src/permissions/approval.js";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {createTurnAbortController} from "../../src/runtime/abort.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";
import {loadSession} from "../../src/session/index.js";

function latch() {
    let resolve = () => {};
    const promise = new Promise<void>(done => {resolve = done;});
    return {promise, resolve};
}

test.each(["ask", "deny"] as const)("workspace delegation preserves explicit %s rules and records human approval without prompt contents", async rule => {
    await withTempProject(async cwd => {
        let approvals = 0;
        const events: ApprovalEvent[] = [];
        const ctx = createTestContext(cwd, {canUseTool: async () => {approvals++; return {behavior: "allow"};}});
        ctx.onApprovalEvent = event => {events.push(event);};
        ctx.permissionRules[rule].push({toolName: "agent", source: "local"});
        attachSubagentLauncher(ctx, async request => ({agentId: "fixture", agentType: request.agentType, description: request.description,
            reply: "done", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1}));
        const result = await executeToolResult("agent", JSON.stringify({description: "work", prompt: "PRIVATE-PROMPT"}), ctx, "delegate");
        expect(result.outcome).toBe(rule === "ask" ? "ok" : "denied");
        expect(approvals).toBe(rule === "ask" ? 1 : 0);
        if (rule === "ask") {
            expect(events.map(event => event.phase)).toEqual(["start", "end"]);
            expect(events[1]).toMatchObject({source: "user", outcome: "allow", toolCallId: "delegate", reason: "Explicit ask rule"});
            expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0);
            expect(JSON.stringify(events)).not.toContain("PRIVATE-PROMPT");
        }
    });
});

test("two authorized delegates join before final answer without UI delivery or approval", async () => {
    await withTempProject(async cwd => {
        const gates = [latch(), latch()];
        let approvals = 0;
        let childIndex = 0;
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => {
            const index = childIndex++;
            expect(request.workspaceWriteApproved).toBe(true);
            return {agentId: options.agentId, async run() {
                await gates[index]!.promise;
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: `finished-${index}`, reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
            }};
        });
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks, canUseTool: async () => {approvals++; return {behavior: "allow"};}});
        const history: Message[] = [];
        attachSubagentLauncher(ctx, async () => {throw new Error("Must run in background");}, () => history);
        const spawn = (index: number) => assistantToolCall("agent", {description: `part-${index}`, prompt: "implement", run_in_background: true}, `spawn-${index}`);
        const first = spawn(0), second = spawn(1);
        const calls = [...first.toolCalls, ...second.toolCalls];
        const fake = createFakeLLM([
            {...first, message: {role: "assistant", content: null, tool_calls: calls}, toolCalls: calls},
            assistantText("I will wait and integrate later."),
            options => {expect(JSON.stringify(options.messages)).toContain("finished-0"); return assistantText("Waiting for the remaining worker.");},
            options => {expect(JSON.stringify(options.messages)).toContain("finished-1"); return assistantText("Integrated and verified both results.");},
        ]);
        let waits = 0;
        const finals: string[] = [];
        try {
            const result = await runAgentForTest("build both parts", history, event => {
                if (event.type === "agent_wait" && event.taskIds.length) gates[waits++]!.resolve();
                if (event.type === "assistant_text" && event.phase === "final") finals.push(event.content);
            }, ctx, {callLLM: fake.callLLM});
            expect(result.reason).toBe("completed");
            expect(finals).toEqual(["Integrated and verified both results."]);
            expect(approvals).toBe(0);
            expect(waits).toBe(2);
            expect(fake.calls).toHaveLength(4);
            for (const call of calls) expect(history.filter(message => message.role === "tool" && message.tool_call_id === call.id)).toHaveLength(1);
            const notifications = await tasks.pendingNotifications();
            for (const notification of notifications) expect(ctx.agentJoin!.accepts({source: "task_notification", id: notification.notificationId, taskId: notification.taskId, content: notification.message})).toBe(false);
        } finally {for (const gate of gates) gate.resolve(); await runtime.close();}
    });
});

test.each(["user", "cancel"] as const)("waiting parent responds to %s without waiting for child completion", async mode => {
    await withTempProject(async cwd => {
        const gate = latch();
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => ({agentId: options.agentId, async run() {
            await gate.promise;
            return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                reply: "late result", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
        }}));
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const controller = createTurnAbortController();
        const ctx = createTestContext(cwd, {tasks, signal: controller.signal});
        const queue = new RuntimeMessageQueue();
        attachSubagentLauncher(ctx, async () => {throw new Error("foreground");});
        const fake = createFakeLLM([
            assistantToolCall("agent", {description: "work", prompt: "work", run_in_background: true}, "spawn"),
            assistantText("I will integrate later."),
            options => {expect(JSON.stringify(options.messages)).toContain("additional constraint"); gate.resolve(); controller.abort("user-cancel"); return assistantText("cancelled");},
        ]);
        try {
            const result = await runAgentForTest("implement", [], event => {
                if (event.type === "agent_wait" && event.taskIds.length) {
                    if (mode === "cancel") controller.abort("user-cancel");
                    else queue.enqueueUser("additional constraint");
                }
            }, ctx, {callLLM: fake.callLLM, inputChannel: queue.createAgentInputChannel(() => {})});
            expect(result.reason).toBe("interrupted");
            expect(fake.calls).toHaveLength(mode === "cancel" ? 2 : 3);
        } finally {gate.resolve(); await runtime.close();}
    });
});

test("wait sees an already completed failed task and deduplicates its run, but shell tasks cannot be joined", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => ({agentId: options.agentId, async run() {
            return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                reply: "could not finish", reason: "incomplete", iterations: 1, toolUseCount: 0, durationMs: 1};
        }}));
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        try {
            const started = await tasks.startAgent({request: {agentType: "Worker", description: "work", prompt: "work", parentToolCallId: "spawn"}, parentContext: ctx});
            ctx.agentJoin!.register(started);
            await waitForAgentTasks(tasks, [started.id], ctx.signal);
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: started.id}), ctx, "join");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("could not finish");
            expect(ctx.agentJoin!.ids).toEqual([]);
            const shell = await tasks.startShell({command: "printf ready", cwd, toolCallId: "shell"});
            await expect(waitForAgentTasks(tasks, [shell.id], ctx.signal)).rejects.toThrow("unavailable Agent");
            expect(new AgentTaskJoin(tasks).ids).toEqual([]);
        } finally {await runtime.close();}
    });
});

test("headless joins acknowledge notifications only after paired History is persisted", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        const runtime = createTaskRuntimeForTest(cwd, resources.shellRunner, (options, request) => ({agentId: options.agentId, async run() {
            return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                reply: "persisted child evidence", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
        }}));
        const {rootSession: session} = createUITurnSessionRuntime({...resources, taskRuntime: runtime});
        try {
            await session.initialize();
            session.history.push({role: "user", origin: "user", content: "Implement the delegated work"});
            const ctx = session.createContext({signal: new AbortController().signal, onEvent() {},
                getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask", collaborationMode: "build"}),
                host: {canUseTool: async () => ({behavior: "deny", message: "No interaction in this test"}), getPermissionRules: () => ({allow: [], ask: [], deny: []}),
                    getPermissionMode: () => "ask", getCollaborationMode: () => "build", getPermissionPromptPolicy: () => "never", setTodos() {}}});
            const started = await session.taskSession.startAgent({request: {agentType: "Worker", description: "work", prompt: "work", parentToolCallId: "spawn"}, parentContext: ctx});
            ctx.agentJoin!.register(started);
            await waitForAgentTasks(session.taskSession, [started.id], ctx.signal);
            for (const input of await ctx.agentJoin!.collect()) {
                session.history.push({role: "user", origin: "task_notification", content: input.content});
                await ctx.agentJoin!.consume(input);
            }
            expect(await session.taskSession.pendingNotifications()).toHaveLength(1);
            session.history.push({role: "assistant", content: null, tool_calls: [{id: "unpaired", type: "function", function: {name: "read_file", arguments: "{}"}}]});
            await expect(ctx.commitToolBatch!()).rejects.toThrow("not completely paired");
            expect(await session.taskSession.pendingNotifications()).toHaveLength(1);
            session.history.pop();
            await ctx.commitToolBatch!();
            expect(await session.taskSession.pendingNotifications()).toHaveLength(0);
            expect(JSON.stringify(loadSession(resources.storage, cwd, session.sessionId, resources.model)?.history)).toContain("persisted child evidence");
        } finally {await runtime.close(); await resources.close();}
    });
});

test("explicit wait includes sibling delegates and leaves unfinished work pending", async () => {
    await withTempProject(async cwd => {
        const gates = [latch(), latch()];
        let index = 0;
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => {
            const gate = gates[index++]!;
            return {agentId: options.agentId, async run() {
                await gate.promise;
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: request.description, reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
            }};
        });
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        try {
            const board = await tasks.startAgent({request: {agentType: "Worker", description: "board result", prompt: "work", parentToolCallId: "board"}, parentContext: ctx});
            const ui = await tasks.startAgent({request: {agentType: "Worker", description: "ui result", prompt: "work", parentToolCallId: "ui"}, parentContext: ctx});
            ctx.agentJoin!.register(board);
            ctx.agentJoin!.register(ui);
            const waiting = executeToolResult("task", JSON.stringify({action: "wait", task_id: ui.id}), ctx, "wait");
            gates[0]!.resolve();
            const result = await waiting;
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain("board result");
            expect(result.modelContent).not.toContain("ui result");
            expect(ctx.agentJoin!.ids).toEqual([ui.id]);
            const remaining = executeToolResult("task", JSON.stringify({action: "wait"}), ctx, "wait-any");
            gates[1]!.resolve();
            expect((await remaining).modelContent).toContain("ui result");
            expect(ctx.agentJoin!.ids).toEqual([]);
            expect((await executeToolResult("task", '{"action":"wait"}', ctx, "empty")).modelContent).toContain("No delegated");
        } finally {gates.forEach(gate => gate.resolve()); await runtime.close();}
    });
});

test.each(["user", "agent", "cancel"] as const)("task wait wakes on %s and preserves safe-boundary input", async kind => {
    await withTempProject(async cwd => {
        const gate = latch();
        const base = createTestContext(cwd);
        const queue = new RuntimeMessageQueue();
        const controller = createTurnAbortController();
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => ({agentId: options.agentId, async run() {
            await gate.promise;
            return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                reply: "done", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
        }}));
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore, messageQueue: queue});
        const ctx = createTestContext(cwd, {tasks, signal: controller.signal});
        ctx.agentMessaging = tasks.messaging;
        try {
            const started = await tasks.startAgent({request: {agentType: "Worker", description: "work", prompt: "work", parentToolCallId: "spawn"}, parentContext: ctx});
            ctx.agentJoin!.register(started);
            let returned = false;
            const waiting = executeToolResult("task", '{"action":"wait"}', ctx, "wait").then(result => {returned = true; return result;});
            queue.enqueueUser("next turn only", "later");
            await tasks.get(started.id);
            expect(returned).toBe(false);
            if (kind === "cancel") controller.abort("user-cancel");
            else if (kind === "user") queue.enqueueUser("new requirement");
            else queue.enqueueAgent("interface question", {sender: started.id, recipient: "parent", runCount: 1, intent: "message"});
            const result = await waiting;
            expect(result.outcome).toBe(kind === "cancel" ? "interrupted" : "ok");
            expect(ctx.agentJoin!.ids).toEqual([started.id]);
            const inputs = queue.createAgentInputChannel(() => {}).drainSafeBoundary();
            expect(inputs).toHaveLength(kind === "cancel" ? 0 : 1);
            expect(queue.list()).toHaveLength(1);
            expect(queue.list()[0]!.priority).toBe("later");
        } finally {gate.resolve(); await runtime.close();}
    });
});

test("one explicit wait spans child progress without another model call and pairs its result", async () => {
    await withTempProject(async cwd => {
        const gate = latch();
        const waiting = latch();
        const base = createTestContext(cwd);
        const progress = latch();
        const progressed = latch();
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => ({agentId: options.agentId, async run() {
            await progress.promise;
            await options.onChildEvent?.({type: "iteration", current: 2});
            progressed.resolve();
            await gate.promise;
            return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                reply: "module verification evidence", reason: "completed", iterations: 2, toolUseCount: 0, durationMs: 1};
        }}));
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        attachSubagentLauncher(ctx, async () => {throw new Error("must run in background");});
        const history: Message[] = [];
        const fake = createFakeLLM([
            assistantToolCall("agent", {description: "module", prompt: "implement", run_in_background: true}, "spawn"),
            assistantToolCall("task", {action: "wait"}, "wait-any"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("module verification evidence");
                expect(options.messages.filter(message => message.role === "tool" && message.tool_call_id === "wait-any")).toHaveLength(1);
                return assistantText("Integrated the module.");
            },
        ]);
        let run: ReturnType<typeof runAgentForTest> | undefined;
        try {
            run = runAgentForTest("implement", history, event => {
                if (event.type === "tool_call_start" && event.toolCallId === "wait-any") waiting.resolve();
            }, ctx, {callLLM: fake.callLLM});
            await waiting.promise;
            progress.resolve();
            await progressed.promise;
            expect(fake.calls).toHaveLength(2);
            expect((await tasks.list())[0]?.status).toBe("running");
            gate.resolve();
            expect((await run).reply).toBe("Integrated the module.");
            expect(fake.calls).toHaveLength(3);
            expect(ctx.agentJoin!.ids).toEqual([]);
        } finally {progress.resolve(); gate.resolve(); await run; await runtime.close();}
    });
});
