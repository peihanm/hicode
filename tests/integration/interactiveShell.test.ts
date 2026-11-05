import {expect, test} from "bun:test";
import {runShellCommand} from "../../src/tools/bash/process.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";

test("PTY receives input in the original live process, drains output and refuses input after exit", async () => {
    await withTempProject(async cwd => {
        let write: ((text: string) => number) | undefined;
        const result = await runShellCommand({command: "test -t 0 && test -t 1 || exit 17; read -r first; read -r second; printf 'RESULT:%s:%s\\n' \"$first\" \"$second\"",
            cwd, tty: true, signal: new AbortController().signal, timeoutMs: 2_000,
            onInputReady: input => {write = input; expect(input("你好\nsecond\n")).toBe(Buffer.byteLength("你好\nsecond\n"));},
        });
        expect(result.termination).toEqual({kind: "exit", code: 0, signal: null});
        expect(result.stdout).toContain("RESULT:你好:second");
        expect(() => write!("too late\n")).toThrow("no longer accepting");
    });
});

test("PTY cancellation and output limits terminate the process", async () => {
    await withTempProject(async cwd => {
        const controller = new AbortController();
        const running = runShellCommand({command: "read -r input", cwd, tty: true, signal: controller.signal,
            onStarted: () => controller.abort("user-cancel")});
        expect((await running).termination.kind).toBe("aborted");
        const limited = await runShellCommand({command: "while :; do printf 'abcdefghijklmnopqrstuvwxyz\\n'; done", cwd, tty: true,
            maxBuffer: 128, signal: new AbortController().signal, timeoutMs: 2_000});
        expect(limited.termination.kind).toBe("output_limit");
    });
});

test("interactive Bash/task input uses ownership and current permissions, never restarts completed tasks", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = {...base, tasks};
        try {
            const started = await executeToolResult("bash", JSON.stringify({command: "read -r value; printf 'RESULT:%s\\n' \"$value\"", tty: true, yield_time_ms: 100}), ctx, "start-pty");
            expect(started.outcome).toBe("ok");
            const target = (await tasks.list())[0]!;
            expect(target.kind).toBe("shell");
            expect(target.status).toBe("running");
            const request = JSON.stringify({action: "input", task_id: target.id, text: "task-ok\n"});
            expect((await executeToolResult("task", request, {...ctx, readOnlyTools: true}, "readonly")).outcome).toBe("denied");
            expect((await executeToolResult("task", request, {...ctx, permissionRules: {allow: [], ask: [], deny: [{toolName: "bash", source: "host"}]}}, "deny")).outcome).toBe("denied");
            const foreign = runtime.forSession({sessionId: "other", toolResultStore: createTestToolResultStore(cwd, "other")});
            await expect(foreign.writeShellInput(target.id, "bad\n", ctx.signal)).rejects.toThrow("owned");
            const sent = await executeToolResult("task", request, ctx, "send");
            expect(sent.outcome).toBe("ok");
            const done = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id, wait_ms: 2_000}), ctx, "wait");
            expect(done.outcome).toBe("ok");
            expect(done.modelContent).toContain("RESULT:task-ok");
            const late = await executeToolResult("task", request, ctx, "late");
            expect(late.outcome).toBe("failed");
            expect(late.modelContent).toContain("already ended (completed; exit code 0)");
            expect(late.modelContent).toContain("No input was sent");
            expect(late.modelContent).not.toContain("Permission denied");
            await expect(tasks.writeShellInput(target.id, "late\n", ctx.signal)).rejects.toThrow("already ended");
            expect((await tasks.get(target.id))?.status).toBe("completed");
            expect((await executeToolResult("bash", JSON.stringify({command: "read -r x", tty: true}), {...ctx, readOnlyTools: true}, "readonly-start")).outcome).toBe("denied");
        } finally {await runtime.close();}
    });
});

test.skipIf(process.env.HICODE_RUN_SANDBOX_INTEGRATION !== "1")("real Sandbox preserves PTY input and filesystem boundaries", async () => {
    const {createSandboxRuntime} = await import("../../src/sandbox/runtime.js");
    const {createShellRunner} = await import("../../src/tools/bash/shellRunner.js");
    const {testChildEnvironment} = await import("../helpers/childEnvironment.js");
    const {mkdir, readFile, writeFile} = await import("node:fs/promises");
    const {join} = await import("node:path");
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "workspace"); await mkdir(cwd);
        const outside = join(root, "outside"); await writeFile(outside, "original");
        const sandbox = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [], denyWrite: []}, network: {mode: "open", allowedDomains: [], allowLocalBinding: false},
        }});
        try {
            expect(sandbox.status.kind).toBe("ready");
            const runner = createShellRunner(sandbox, testChildEnvironment);
            const result = await runner.run({cwd, tty: true, command: "test -t 0 || exit 17; read -r value; printf '%s' \"$value\" > inside; printf BAD > ../outside",
                signal: AbortSignal.timeout(10_000), timeoutMs: 8_000, onInputReady: write => {write("sandbox-ok\n");}});
            expect(result.termination).toMatchObject({kind: "exit", code: 1});
            expect(await readFile(join(cwd, "inside"), "utf8")).toBe("sandbox-ok");
            expect(await readFile(outside, "utf8")).toBe("original");
        } finally {await sandbox.close();}
    });
});

test("input reports a missing terminal as state failure, keeps ownership denials private and never asks for approval", async () => {
    await withTempProject(async cwd => {
        let approvals = 0;
        const base = createTestContext(cwd, {canUseTool: async () => {approvals++; return {behavior: "allow"};}});
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = {...base, tasks};
        try {
            const target = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "non-interactive"});
            const input = JSON.stringify({action: "input", task_id: target.id, text: "hello\n"});
            const result = await executeToolResult("task", input, ctx, "no-tty");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("no open interactive terminal");
            expect(result.modelContent).toContain("tty=true");
            expect(result.modelContent).not.toContain("Permission denied");
            expect((await tasks.get(target.id))?.status).toBe("running");
            const other = runtime.forSession({sessionId: "foreign", toolResultStore: createTestToolResultStore(cwd, "foreign")});
            const denied = await executeToolResult("task", input, {...ctx, tasks: other}, "foreign-input");
            expect(denied.outcome).toBe("denied");
            expect(denied.modelContent).toContain("not found in this Session");
            expect(denied.modelContent).not.toContain("sleep 30");
            expect(denied.modelContent).not.toContain("no open interactive terminal");
            expect(approvals).toBe(0);
        } finally {await runtime.close();}
    });
});
