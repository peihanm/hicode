import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSubagentFactories} from "../../src/subagents/runSubagent.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import type {AgentRunner} from "../../src/agent/index.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";
import {createTaskJournal} from "../../src/tasks/journal.js";
import {createHiCodeStorageLayout} from "../../src/persistence/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {executeToolResult} from "../helpers/executeTool.js";

test.each([false, true])("child Shell owns readable inline and background output, inherited=%s", async inherited => {
    await withTempProject(async cwd => {
        const hicodeHome = join(cwd, "home");
        const store = createTestToolResultStore(cwd, "parent", {hicodeHome});
        const parent = createTestContext(cwd, {sessionId: "parent", toolResultStore: store});
        const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, undefined, hicodeHome);
        const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: store});
        parent.tasks = tasks;
        await writeFile(join(cwd, "large.txt"), "owned output\n".repeat(5000));
        const runner: AgentRunner = async (_input, _history, _onEvent, ctx) => {
            if (!ctx.tasks) throw new Error("Missing child tasks");
            expect(ctx.tasks.sessionId).toBe(ctx.sessionId);
            const started = await ctx.tasks.startShell({command: "cat large.txt", cwd, toolCallId: "background"});
            await waitForTaskCompletion(ctx.tasks, [started.id], ctx.signal, "shell");
            const finished = await ctx.tasks.get(started.id);
            if (finished?.kind !== "shell" || !finished.outputResult) throw new Error("Missing Shell output");
            expect(await tasks.get(started.id)).toBeUndefined();
            const inline = await ctx.tasks.runShell({command: "cat large.txt", cwd, toolCallId: "inline",
                waitMs: 5000, signal: ctx.signal, onHandoff() {}});
            if (inline.kind !== "inline" || !inline.persisted) throw new Error("Missing inline output");
            for (const artifact of [finished.outputResult, inline.persisted]) {
                expect(await ctx.toolResultStore.resolveFile(artifact.path)).not.toBeNull();
                const read = await executeToolResult("read_file", JSON.stringify({path: artifact.path, limit: 1}), ctx, "read");
                expect(read.outcome).toBe("ok");
                expect(read.modelContent).toContain("owned output");
                await expect(store.resolveFile(artifact.path)).rejects.toThrow("unauthorized session");
            }
            const journal = createTaskJournal(createHiCodeStorageLayout({hicodeHome}), cwd);
            expect((await journal.load(ctx.toolResultStore.owner)).tasks.map(task => task.id)).toContain(started.id);
            expect((await journal.load(parent.sessionId)).tasks).toHaveLength(0);
            return {reply: "verified", reason: "completed", iterations: 1};
        };
        const factories = createSubagentFactories({primaryRunAgent: runner, fastRunAgent: runner,
            registry: BUILTIN_SUBAGENT_REGISTRY,
            createToolResultStore: (ownerCwd, id) => createTestToolResultStore(ownerCwd, id, {hicodeHome})});
        try {
            const child = factories.createSubagentThread({parentContext: parent, agentId: "worker", onEvent() {}},
                {agentType: "Worker", name: "worker", description: "fixture", prompt: "fixture", parentToolCallId: "spawn",
                    ...(inherited ? {contextSnapshot: {history: [{role: "system" as const, content: "fixture"}]}} : {})});
            expect((await child.run({prompt: "fixture", signal: parent.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL})).reply).toBe("verified");
            expect(await tasks.pendingNotifications()).toHaveLength(0);
        } finally {await runtime.close();}
    });
});

test("closing a parent Session closes descendant Shells without closing the shared Runtime", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const parent = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        const child = parent.createChildShellSession(createTestToolResultStore(cwd, {parentSessionId: ctx.sessionId, agentId: "child"})).tasks;
        const other = runtime.forSession({sessionId: "other", toolResultStore: createTestToolResultStore(cwd, "other")});
        try {
            const task = await child.startShell({command: "sleep 30", cwd, toolCallId: "service"});
            await parent.close();
            await parent.close();
            expect((await child.get(task.id))?.status).toBe("cancelled");
            await expect(child.startShell({command: "true", cwd, toolCallId: "closed"})).rejects.toThrow("closed");
            const result = await other.runShell({command: "printf independent", cwd, toolCallId: "other", waitMs: 1000,
                signal: ctx.signal, onHandoff() {}});
            expect(result.kind).toBe("inline");
        } finally {await runtime.close();}
    });
});

test("Session close waits for a Shell still allocating its output capture and reclaims it", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const parent = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        const store = createTestToolResultStore(cwd, {parentSessionId: ctx.sessionId, agentId: "child"});
        const child = parent.createChildShellSession(store).tasks;
        let entered!: () => void, release!: () => void;
        const allocating = new Promise<void>(resolve => {entered = resolve;});
        const gate = new Promise<void>(resolve => {release = resolve;});
        const capture = store.createCapture.bind(store);
        store.createCapture = async () => {entered(); await gate; return capture();};
        const started = child.startShell({command: "sleep 30", cwd, toolCallId: "pending"});
        void started.catch(() => {});
        try {
            await allocating;
            const closing = parent.close();
            release();
            await closing;
            await expect(started).rejects.toThrow("closed");
            expect(runtime.hasRunning()).toBe(false);
        } finally {release(); await runtime.close();}
    });
});

test("parent task cleanup errors do not skip descendant Shell cleanup", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const parent = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        const child = parent.createChildShellSession(createTestToolResultStore(cwd, {parentSessionId: ctx.sessionId, agentId: "child"})).tasks;
        try {
            await parent.startShell({command: "sleep 30", cwd, toolCallId: "parent"});
            const own = await child.startShell({command: "sleep 30", cwd, toolCallId: "child"});
            const stop = parent.stop.bind(parent);
            parent.stop = async id => {await stop(id); throw new Error("fixture final journal failure");};
            await expect(parent.close()).rejects.toThrow("cleanup failed");
            expect((await child.get(own.id))?.status).toBe("cancelled");
            expect(runtime.hasRunning()).toBe(false);
        } finally {await runtime.close();}
    });
});

test("interrupt preserves child services for followup; permanent Agent stop closes their scope", async () => withTempProject(async cwd => {
    const parent = createTestContext(cwd);
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let runs = 0;
    let childTasks: import("../../src/tasks/session.js").ChildTaskAccess | undefined;
    let serviceId = "";
    const runner: AgentRunner = async (_input, _history, _onEvent, ctx) => {
        if (!ctx.tasks) throw new Error("Missing child tasks");
        childTasks = ctx.tasks;
        if (!serviceId) serviceId = (await ctx.tasks.startShell({command: "sleep 30", cwd, toolCallId: "service"})).id;
        const index = runs++;
        entered[index]!.resolve();
        if (!ctx.signal.aborted) await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), {once: true}));
        return {reply: "interrupted", reason: "interrupted", iterations: 1};
    };
    const factories = createSubagentFactories({primaryRunAgent: runner, fastRunAgent: runner,
        registry: BUILTIN_SUBAGENT_REGISTRY, createToolResultStore: (ownerCwd, id) => createTestToolResultStore(ownerCwd, id)});
    const runtime = createTaskRuntimeForTest(cwd, parent.shellRunner, factories.createSubagentThread);
    const tasks = runtime.forSession({sessionId: parent.sessionId, toolResultStore: parent.toolResultStore});
    parent.tasks = tasks;
    try {
        const agent = await tasks.startAgent({parentContext: parent, request: {
            agentType: "Worker", name: "worker", description: "fixture", prompt: "fixture", parentToolCallId: "spawn"}});
        await entered[0]!.promise;
        await tasks.interrupt(agent.id);
        expect((await childTasks!.get(serviceId))?.status).toBe("running");
        await tasks.followup(agent.id, "continue");
        await entered[1]!.promise;
        await tasks.stop(agent.id);
        expect((await childTasks!.get(serviceId))?.status).toBe("cancelled");
        expect(runtime.hasRunning()).toBe(false);
        await expect(childTasks!.startShell({command: "true", cwd, toolCallId: "late"})).rejects.toThrow("closed");
        await expect(tasks.followup(agent.id, "late")).rejects.toThrow("cancelled");
    } finally {await runtime.close();}
}));
