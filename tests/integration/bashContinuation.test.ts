import {expect, test} from "bun:test";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createAgentRunner} from "../../src/agent/runner.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {createCompactState} from "../../src/context/state.js";
import {contentText} from "../../src/images/content.js";
import {getSessionStorageDirectory} from "../../src/persistence/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {runRootTurn} from "../../src/runtime/turnRuntime.js";
import {createSDKThread} from "../../src/sdk/thread.js";
import {loadSession} from "../../src/session/index.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {runAgentForTest} from "../helpers/agent.js";
import {continuityHost} from "../helpers/continuity.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";

function fixture(cwd: string) {
    const resources = createTestRuntimeResources(cwd);
    const base = createTestContext(cwd, {permissionMode: "full-access", fileCommits: resources.fileCommits});
    const tasks = resources.taskRuntime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
    const ctx = createTestContext(cwd, {permissionMode: "full-access", tasks,
        fileCommits: resources.fileCommits, toolResultStore: base.toolResultStore});
    return {resources, tasks, ctx};
}

test("a finite Shell does not queue another command behind its process lifetime", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        try {
            const first = await tasks.runShell({command: "sleep 30", cwd, toolCallId: "lock-owner", waitMs: 100,
                signal: ctx.signal, onHandoff() {}});
            expect(first.kind).toBe("task");
            const next = await tasks.runShell({command: "printf ready > next-start", cwd, toolCallId: "next", waitMs: 1000,
                signal: ctx.signal, onHandoff() {}});
            expect(next.kind).toBe("inline");
            expect(await readFile(join(cwd, "next-start"), "utf8")).toBe("ready");
            if (first.kind === "task") expect((await tasks.get(first.task.id))?.status).toBe("running");
            if (first.kind === "task") await tasks.stop(first.task.id);
        } finally {await resources.close();}
    });
});

test("task mistakes return accessible IDs without rerunning work or exposing another Session", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        try {
            const task = await tasks.startShell({command: "printf original", cwd, toolCallId: "original"});
            for (const task_id of [undefined, "12", "t_000000000000"]) {
                const result = await executeToolResult("task", JSON.stringify({action: "status", task_id}), ctx, "mistake");
                expect(result.outcome).toBe("failed");
                expect(result.modelContent).toContain(`task_id: ${task.id}`);
                expect(result.modelContent).toContain('"action":"status"');
            }
            const interrupted = await executeToolResult("task", JSON.stringify({action: "interrupt", task_id: task.id}), ctx, "wrong-action");
            expect(interrupted.modelContent).toContain("Use stop");
            const foreign = resources.taskRuntime.forSession({sessionId: "another", toolResultStore: ctx.toolResultStore});
            const hidden = await executeToolResult("task", JSON.stringify({action: "status", task_id: task.id}), {...ctx, tasks: foreign}, "foreign");
            expect(hidden.modelContent).toContain("No accessible tasks");
            expect(hidden.modelContent).not.toContain(task.id);
            expect(await tasks.list()).toHaveLength(1);
        } finally {await resources.close();}
    });
});

test("structured file writes proceed while an unrelated finite Shell runs", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        await writeFile(join(cwd, "evidence.txt"), "existing evidence");
        try {
            const owner = await tasks.runShell({command: "sleep 30", cwd, toolCallId: "writer", waitMs: 100,
                signal: ctx.signal, onHandoff() {}});
            if (owner.kind !== "task") throw new Error("Expected held writer");
            const read = await executeToolResult("bash", JSON.stringify({command: "sleep 0.01; cat evidence.txt"}), ctx, "read");
            expect(read.outcome).toBe("ok");
            expect(read.modelContent).toContain("existing evidence");
            expect((await tasks.get(owner.task.id))?.status).toBe("running");
            const write = await executeToolResult("write_file", JSON.stringify({path: "new.txt", content: "saved"}), ctx, "write");
            expect(write.outcome).toBe("ok");
            expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("saved");
        } finally {await resources.close();}
    });
});

test("default 10s Bash hands off once, wait retrieves the same process exit and output", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        const events: string[] = [];
        tasks.subscribe(event => events.push(event.type));
        try {
            const started = await executeToolResult("bash", JSON.stringify({
                command: 'printf "%s\\n" "$$" >> starts; sleep 11; printf finished-once; exit 7',
            }), ctx, "default-job");
            expect(started.outcome).toBe("ok");
            expect(started.runningTask).toBeDefined();
            expect(started.modelContent).toContain("still running");
            const id = started.runningTask!;
            const waited = await executeToolResult("task", JSON.stringify({action: "wait", task_id: id}), ctx, "collect");
            expect(waited.outcome).toBe("failed");
            expect(waited.modelContent).toContain("exit code 7");
            expect(waited.modelContent).toContain("finished-once");
            expect(waited.completedTask?.taskId).toBe(id);
            const again = await executeToolResult("task", JSON.stringify({action: "wait", task_id: id}), ctx, "again");
            expect(again.modelContent).toEqual(waited.modelContent);
            expect((await readFile(join(cwd, "starts"), "utf8")).trim().split("\n")).toHaveLength(1);
            expect(events).toEqual(["task_started", "task_finished"]);
        } finally {await resources.close();}
    });
}, 20_000);

test("short ordinary Bash has inline output and no public task, notification or artifact", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        const events: string[] = [];
        tasks.subscribe(event => events.push(event.type));
        try {
            const result = await executeToolResult("bash", '{"command":"printf short; exit 3"}', ctx, "short");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("short");
            expect(result.modelContent).toContain("Command exited with code 3");
            expect(result.runningTask).toBeUndefined();
            expect(result.completedTask).toBeUndefined();
            expect(await tasks.list()).toEqual([]);
            expect(await tasks.pendingNotifications()).toEqual([]);
            expect(events).toEqual([]);
            const files = await readdir(ctx.toolResultStore.sessionDir);
            expect(files.filter(name => name.endsWith(".txt") || name.endsWith(".meta.json"))).toEqual([]);
        } finally {await resources.close();}
    });
});

test("yielded Shell has no execution deadline and completes through the same task", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd, {permissionMode: "full-access"});
        const limits: Array<number | null | undefined> = [];
        const runner: ShellRunnerLike = {...base.shellRunner, run(input) {
            limits.push(input.timeoutMs); return base.shellRunner.run(input);
        }};
        const runtime = createTaskRuntimeForTest(cwd, runner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = {...base, tasks};
        try {
            const started = await executeToolResult("bash", JSON.stringify({
                command: 'node -e \'const fs = require("fs"); fs.appendFileSync("starts", "once\\n"); const timer = setInterval(() => {if (fs.existsSync("release")) {clearInterval(timer); process.stdout.write("finished");}}, 10);\'',
                yield_time_ms: 100,
            }), ctx, "finite");
            expect(started.runningTask).toBeDefined();
            expect(limits).toEqual([null]);
            const id = started.runningTask!;
            for (let i = 0; i < 2; i++) {
                const waited = await executeToolResult("task", JSON.stringify({action: "wait", task_id: id, wait_ms: 5}), ctx, `wait-${i}`);
                expect(waited.completedTask).toBeUndefined();
                expect((await tasks.get(id))?.status).toBe("running");
            }
            await writeFile(join(cwd, "release"), "go");
            const done = await executeToolResult("task", JSON.stringify({action: "wait", task_id: id}), ctx, "finish");
            expect(done.outcome).toBe("ok");
            expect(done.modelContent).toContain("finished");
            expect(await readFile(join(cwd, "starts"), "utf8")).toBe("once\n");
            expect(limits).toEqual([null]);
        } finally {await runtime.close();}
    });
});

test("waiting window includes Sandbox preparation and hands off the same pending task", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd, {permissionMode: "full-access"});
        let prepare!: () => void;
        const prepared = new Promise<void>(resolve => {prepare = resolve;});
        let entered!: () => void;
        const entering = new Promise<void>(resolve => {entered = resolve;});
        const runner: ShellRunnerLike = {sandboxStatus: base.shellRunner.sandboxStatus, async run(input) {
            entered(); await prepared; return base.shellRunner.run(input);
        }};
        const runtime = createTaskRuntimeForTest(cwd, runner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        let handedOff = false;
        const operation = tasks.runShell({command: "printf prepared", cwd, toolCallId: "prepare", waitMs: 100,
            signal: base.signal, onHandoff() {handedOff = true;}});
        try {
            await entering;
            await Bun.sleep(150);
            const result = await operation;
            expect(handedOff).toBe(true);
            expect(result.kind).toBe("task");
            if (result.kind !== "task") throw new Error("Expected a pending task");
            expect(result.task.phase).toBe("starting");
            prepare();
            const waited = await executeToolResult("task", JSON.stringify({action: "wait", task_id: result.task.id}), {...base, tasks}, "prepared-wait");
            expect(waited.modelContent).toContain("prepared");
        } finally {prepare(); await operation; await runtime.close();}
    });
});

test("handed-off finite Shell does not block structured file commits", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        try {
            const start = await executeToolResult("bash", '{"command":"sleep 0.4; printf complete","yield_time_ms":100}', ctx, "coordinated");
            expect(start.runningTask).toBeDefined();
            const edit = await executeToolResult("write_file", JSON.stringify({path: "during-test.txt", content: "ready"}), ctx, "during-test");
            expect(edit.outcome).toBe("ok");
            expect(await readFile(join(cwd, "during-test.txt"), "utf8")).toBe("ready");
            await executeToolResult("task", JSON.stringify({action: "wait", task_id: start.runningTask}), ctx, "wait");
            await tasks.startShell({command: "sleep 30", cwd, toolCallId: "service"});
            const later = await executeToolResult("write_file", JSON.stringify({path: "during-service.txt", content: "ready"}), ctx, "during-service");
            expect(later.outcome).toBe("ok");
        } finally {await resources.close();}
    });
});

test("TaskJoin waits for finite Bash before accepting final text, but excludes explicit services", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: 'node -e \'const fs = require("fs"); const timer = setInterval(() => {if (fs.existsSync("release")) {clearInterval(timer); process.stdout.write("verified");}}, 10);\'', yield_time_ms: 100}, "finite"),
            assistantText("premature final"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("is completed");
                expect(JSON.stringify(options.messages)).not.toContain("premature final");
                return assistantText("Result collected.");
            },
        ]);
        const events: AgentEvent[] = [];
        try {
            const service = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "service"});
            const result = await runAgentForTest("run", [], event => {
                events.push(event);
                if (event.type === "task_wait" && event.taskIds.length) void writeFile(join(cwd, "release"), "go");
            }, ctx, {callLLM: fake.callLLM});
            expect(result.reply).toBe("Result collected.");
            expect(events.some(event => event.type === "task_wait" && event.taskIds.length === 1)).toBe(true);
            expect(ctx.taskJoin!.ids).toEqual([]);
            expect((await tasks.get(service.id))?.status).toBe("running");
        } finally {await resources.close();}
    });
});

test("iteration budget cannot turn a pending finite Shell into a successful final answer", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx} = fixture(cwd);
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: "sleep 30", yield_time_ms: 100}, "finite"),
            assistantText("all finished"),
        ]);
        try {
            const result = await runAgentForTest("run", [], () => {}, ctx, {callLLM: fake.callLLM, maxIterations: 2});
            expect(result.reason).toBe("max_turns");
            expect(result.reply).not.toContain("all finished");
        } finally {await resources.close();}
    });
});

test("Shell result receipt is ACKed only after paired History is saved, and wait emits no duplicate notification", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage});
        let id: string | undefined;
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: "sleep 0.3; printf durable-evidence", yield_time_ms: 100}, "start"),
            options => {
                id = contentText(options.messages.find(message => message.role === "tool" && message.tool_call_id === "start")?.content ?? "").match(/task_id: (t_[0-9a-f]{12})/)?.[1];
                expect(id).toBeDefined();
                return assistantToolCall("task", {action: "wait", task_id: id}, "wait");
            },
            async options => {
                const saved = loadSession(storage, cwd, "durable-shell")!;
                expect(saved.history.find(message => message.role === "tool" && message.tool_call_id === "wait")?.content).toContain("durable-evidence");
                expect(await session.taskSession.pendingNotifications()).toEqual([]);
                expect(options.messages.filter(message => message.role === "user" && contentText(message.content).includes("<task-notification>"))).toEqual([]);
                return assistantText("Collected once.");
            },
        ]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM,
            compactHistory: async ({preTokenCount}) => ({compacted: false, preTokenCount, threshold: Number.MAX_SAFE_INTEGER})});
        const session = createRootSessionRuntime({resources, seed: {sessionId: "durable-shell",
            history: [{role: "system", content: "fixture"}], compactState: createCompactState()}});
        const state = () => ({todos: [], permissionMode: "full-access" as const,  uiEvents: []});
        try {
            const result = await runRootTurn({resources, session, prompt: "run", signal: new AbortController().signal,
                host: continuityHost, onEvent() {}, onHookResult() {}, onLifecycleIssue(issue) {throw issue.error;}, getSnapshotState: state});
            expect(result.reply).toBe("Collected once.");
            expect(id).toBeDefined();
        } finally {await resources.close();}
    });
});

test("explicit finite background work survives a normal reply and delivers its completion once in a later turn", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage});
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: 'node -e \'const fs = require("fs"); const timer = setInterval(() => {if (fs.existsSync("release")) {clearInterval(timer); process.stdout.write("background-built");}}, 10);\'', run_in_background: true}, "background"),
            assistantText("Started; the build is still running."),
            options => {
                expect(options.messages.filter(message => message.role === "user" && contentText(message.content).includes("<task-notification>"))).toHaveLength(1);
                expect(JSON.stringify(options.messages)).toContain("background-built");
                return assistantText("The background build completed.");
            },
            options => {
                expect(options.messages.filter(message => message.role === "user" && contentText(message.content).includes("<task-notification>"))).toHaveLength(1);
                return assistantText("No new task results.");
            },
        ]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM,
            compactHistory: async ({preTokenCount}) => ({compacted: false, preTokenCount, threshold: Number.MAX_SAFE_INTEGER})});
        const session = createRootSessionRuntime({resources, seed: {sessionId: "background-across-turns",
            history: [{role: "system", content: "fixture"}], compactState: createCompactState()}});
        const state = () => ({todos: [], permissionMode: "full-access" as const,  uiEvents: []});
        const run = (prompt: string) => runRootTurn({resources, session, prompt, signal: new AbortController().signal,
            host: continuityHost, onEvent() {}, onHookResult() {}, onLifecycleIssue(issue) {throw issue.error;}, getSnapshotState: state});
        let finished!: () => void;
        const completion = new Promise<void>(resolve => {finished = resolve;});
        const unsubscribe = session.taskSession.subscribe(event => {if (event.type === "task_finished") finished();});
        try {
            expect((await run("Start this build in the background; report its result later.")).reply).toContain("still running");
            expect(session.taskSession.hasRunning()).toBe(true);
            expect(fake.calls).toHaveLength(2);
            await writeFile(join(cwd, "release"), "go");
            await completion;
            expect((await run("Check the build.")).reply).toBe("The background build completed.");
            expect(await session.taskSession.pendingNotifications()).toEqual([]);
            await run("Anything else?");
            expect(fake.calls).toHaveLength(4);
        } finally {unsubscribe(); await resources.close();}
    });
});

test("SDK finite continuation is available while services stay disabled; Thread.close cleans pending Shell", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources = createTestRuntimeResources(cwd, {storage});
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: "sleep 30", run_in_background: true}, "service"),
            assistantToolCall("bash", {command: 'printf "%s" "$$" > sdk-pid; sleep 30', yield_time_ms: 100}, "finite"),
        ]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM,
            compactHistory: async ({preTokenCount}) => ({compacted: false, preTokenCount, threshold: Number.MAX_SAFE_INTEGER})});
        const thread = await createSDKThread({resources, seed: {sessionId: "sdk-shell", history: [{role: "system", content: "fixture"}], compactState: createCompactState()},
            state: {todos: [], permissionMode: "full-access",  uiEvents: []}, resumed: false, onClose() {}});
        const tasks = resources.taskRuntime.forSession({sessionId: thread.id, toolResultStore: createTestContext(cwd).toolResultStore});
        try {
            expect((await thread.run("run", {maxIterations: 2})).stopReason).toBe("max_turns");
            expect((await tasks.list()).filter(task => task.status === "running")).toHaveLength(1);
            const pid = Number(await readFile(join(cwd, "sdk-pid"), "utf8"));
            expect(pid).toBeGreaterThan(0);
            await thread.close();
            expect(() => process.kill(pid, 0)).toThrow();
            expect(tasks.hasRunning()).toBe(false);
        } finally {await thread.close(); await resources.close();}
    });
});

test("child default continuation cannot wait for or stop parent Shells", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        const child = tasks.createChildShellSession(createTestToolResultStore(cwd, "child")).tasks;
        try {
            const parent = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "parent"});
            const own = await child.runShell({command: "sleep 0.3; printf child", cwd, toolCallId: "child", waitMs: 100,
                signal: ctx.signal, onHandoff() {}});
            expect(own.kind).toBe("task");
            expect(await child.get(parent.id)).toBeUndefined();
            expect(await child.stop(parent.id)).toBeUndefined();
            expect((await child.list()).filter(task => task.kind === "shell").map(task => task.owner.toolCallId)).toEqual(["child"]);
        } finally {await resources.close();}
    });
});

test("output promotion failure preserves real exit and returns a failed delivery", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx, tasks} = fixture(cwd);
        ctx.toolResultStore.promoteFile = async () => {throw new Error("fixture storage failure");};
        try {
            const start = await executeToolResult("bash", '{"command":"sleep 0.3; printf done","yield_time_ms":100}', ctx, "storage");
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: start.runningTask}), ctx, "wait");
            expect(result.outcome).toBe("output_failed");
            expect(result.modelContent).toContain("exit code 0");
            expect(result.modelContent).toContain("fixture storage failure");
            expect((await tasks.get(start.runningTask!))?.status).toBe("failed");
        } finally {await resources.close();}
    });
});

test("startup service output failure is visible alongside captured output and real exit", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx} = fixture(cwd);
        ctx.toolResultStore.promoteFile = async () => {throw new Error("fixture storage failure");};
        try {
            const result = await executeToolResult("bash", '{"command":"printf captured","run_in_background":true}', ctx, "failed-output");
            expect(result.outcome).toBe("output_failed");
            expect(result.modelContent).toContain("captured");
            expect(result.modelContent).toContain("exit 0");
            expect(result.modelContent).toContain("fixture storage failure");
        } finally {await resources.close();}
    });
});

test("failed handoff terminates its process instead of leaking a running Task", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx, tasks} = fixture(cwd);
        try {
            await expect(tasks.runShell({command: 'printf "%s" "$$" > failed-pid; sleep 30', cwd, toolCallId: "handoff", waitMs: 100,
                signal: ctx.signal, onHandoff() {throw new Error("fixture handoff failure");}})).rejects.toThrow("fixture handoff failure");
            const pid = Number(await readFile(join(cwd, "failed-pid"), "utf8"));
            expect(() => process.kill(pid, 0)).toThrow();
            expect(tasks.hasRunning()).toBe(false);
        } finally {await resources.close();}
    });
});

test("failed Task publication cleans the process and exposes no unregistered task", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx, tasks} = fixture(cwd);
        try {
            await tasks.initialize();
            const path = join(getSessionStorageDirectory(resources.storage, cwd, ctx.sessionId), "tasks", "events.jsonl");
            await mkdir(path, {recursive: true});
            const result = await executeToolResult("bash", JSON.stringify({command: 'printf "%s" "$$" > publication-pid; sleep 30', yield_time_ms: 100}), ctx, "publication");
            expect(result.outcome).toBe("failed");
            const pid = Number(await readFile(join(cwd, "publication-pid"), "utf8"));
            expect(() => process.kill(pid, 0)).toThrow();
            expect(await tasks.list()).toEqual([]);
            expect(tasks.hasRunning()).toBe(false);
        } finally {await resources.close();}
    });
});

test.each(["turn-cancel", "root-close"] as const)("%s before handoff terminates the private Shell", async mode => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        let spawned!: () => void;
        const running = new Promise<void>(resolve => {spawned = resolve;});
        const runner: ShellRunnerLike = {...base.shellRunner, run(input) {
            return base.shellRunner.run({...input, onStarted() {input.onStarted?.(); spawned();}});
        }};
        const runtime = createTaskRuntimeForTest(cwd, runner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const controller = new AbortController();
        const operation = tasks.runShell({command: "sleep 30", cwd, toolCallId: "private", waitMs: 10_000,
            signal: controller.signal, onHandoff() {throw new Error("Must not hand off after cancellation");}});
        try {
            await running;
            expect(await tasks.list()).toEqual([]);
            if (mode === "turn-cancel") controller.abort("user-cancel");
            else await runtime.close();
            const result = await operation;
            expect(result.kind).toBe("inline");
            if (result.kind === "inline") expect(result.result.termination).toMatchObject({kind: "aborted"});
            expect(tasks.hasRunning()).toBe(false);
        } finally {controller.abort("shutdown"); await operation; await runtime.close();}
    });
});

test("large inline output is stored without publishing a short-lived Task", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx, tasks} = fixture(cwd);
        try {
            const result = await executeToolResult("bash", JSON.stringify({command: 'node -e "process.stdout.write(String.fromCharCode(120).repeat(40000))"'}), ctx, "large");
            expect(result.outcome).toBe("ok");
            expect(result.persisted).toBeDefined();
            expect(await readFile(result.persisted!.path, "utf8")).toHaveLength(40000);
            expect(await tasks.list()).toEqual([]);
            expect(await tasks.pendingNotifications()).toEqual([]);
        } finally {await resources.close();}
    });
});

test("one-shot Host omits hard timeout and rejects explicit yield without starting a Task", async () => {
    await withTempProject(async cwd => {
        const {resources, ctx} = fixture(cwd);
        const tasks = resources.taskRuntime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore,
            allowBackgroundTasks: false, shellContinuation: false});
        const limits: Array<number | null | undefined> = [];
        const runner: ShellRunnerLike = {...ctx.shellRunner, async run(input) {limits.push(input.timeoutMs); return ctx.shellRunner.run(input);}};
        const oneShot = {...ctx, tasks, shellRunner: runner};
        try {
            expect((await executeToolResult("bash", '{"command":"printf once"}', oneShot, "oneshot")).outcome).toBe("ok");
            expect(limits).toEqual([null]);
            expect((await executeToolResult("bash", '{"command":"printf never","yield_time_ms":100}', oneShot, "yield")).outcome).toBe("failed");
            expect(limits).toHaveLength(1);
            expect(await tasks.list()).toEqual([]);
        } finally {await resources.close();}
    });
});

test("ordinary nonzero exits retain structured presentation through inline Bash and task status/wait", async () => {
    await withTempProject(async cwd => {
        const {resources, tasks, ctx} = fixture(cwd);
        try {
            const inline = await executeToolResult("bash", JSON.stringify({command: "printf 'EXIT=0'; exit 1"}), ctx, "inline-exit");
            const uiData = {type: "shell_result", receipt: {termination: "exit", outputFailed: false}};
            expect(inline).toMatchObject({outcome: "failed", uiData});
            expect(inline.modelContent).toContain("Command exited with code 1");
            expect(inline.modelContent).toContain("EXIT=0");
            const task = await tasks.startShell({command: "printf 'EXIT=0'; exit 1", cwd, toolCallId: "background-exit"});
            const waited = await executeToolResult("task", JSON.stringify({action: "wait", task_id: task.id, wait_ms: 1000}), ctx, "wait-exit");
            const status = await executeToolResult("task", JSON.stringify({action: "status", task_id: task.id}), ctx, "status-exit");
            for (const result of [waited, status]) {
                expect(result).toMatchObject({outcome: "failed", uiData});
                expect(result.modelContent).toContain("exit code 1");
            }
        } finally {await resources.close();}
    });
});
