import {executeDeliveredTool} from "../helpers/executeTool.js";
import {describe, expect, test} from "bun:test";
import {chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile} from "node:fs/promises";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createFileCheckpointRuntime} from "../../src/checkpoints/runtime.js";
import {executeToolCallBatch} from "../../src/agent/toolBatch.js";
import type {Message, ToolCall} from "../../src/llm/types.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {FileCommitCoordinator} from "../../src/checkpoints/fileCommit.js";
import {SDKEventAdapter} from "../../src/sdk/eventAdapter.js";
import type {ThreadEventPayload} from "../../src/sdk/protocol.js";

const calls = [
    {name: "edit_file", input: {path: "file.txt", old_string: "before", new_string: "after"}},
    {name: "write_file", input: {path: "file.txt", content: "after\n"}},
    {name: "delete_file", input: {path: "file.txt"}},
] as const;

describe("file commit boundary", () => {
    test("cancelled queued writer exits without blocking the next writer", async () => {
        await withTempProject(async cwd => {
            const coordinator = new FileCommitCoordinator();
            const controller = new AbortController();
            let release!: () => void;
            const gate = new Promise<void>(done => { release = done; });
            const first = coordinator.run(`${cwd}/file.txt`, new AbortController().signal, () => gate);
            let called = false;
            const second = coordinator.run(`${cwd}/file.txt`, controller.signal, async () => { called = true; });
            controller.abort("user-cancel");
            try {
                await expect(second).rejects.toThrow();
                expect(called).toBe(false);
            } finally { release(); }
            await first;
            expect(await coordinator.run(`${cwd}/file.txt`, new AbortController().signal, async () => "next")).toBe("next");
        });
    });

    test("parent directory replacement during capture cannot redirect the write", async () => {
        await withTempProject(async (cwd, storage) => {
            await mkdir(`${cwd}/target`);
            await mkdir(`${cwd}/external`);
            await writeFile(`${cwd}/target/file.txt`, "before\n");
            await writeFile(`${cwd}/external/file.txt`, "before\n");
            const ctx = createTestContext(cwd);
            const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "parent", enabled: true});
            ctx.fileCheckpoints = checkpoints;
            await checkpoints.beginTurn({prompt: "edit"});
            const tools = createToolRuntime();
            await executeDeliveredTool(tools, "read_file", '{"path":"target/file.txt"}', ctx, "read");
            const before = checkpoints.beforeWrite.bind(checkpoints);
            checkpoints.beforeWrite = async input => {
                const result = await before(input);
                await rename(`${cwd}/target`, `${cwd}/original`);
                await symlink(`${cwd}/external`, `${cwd}/target`);
                return result;
            };
            const result = await tools.executeTool("edit_file", JSON.stringify({...calls[0].input, path: "target/file.txt"}), ctx, "edit");
            expect(result.outcome).toBe("failed");
            expect(await readFile(`${cwd}/original/file.txt`, "utf8")).toBe("before\n");
            expect(await readFile(`${cwd}/external/file.txt`, "utf8")).toBe("before\n");
            expect(await readdir(`${cwd}/external`)).toEqual(["file.txt"]);
        });
    });

    test("a failed after record keeps the committed change and reports missing coverage", async () => {
        await withTempProject(async (cwd, storage) => {
            const ctx = createTestContext(cwd);
            const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "after-error", enabled: true});
            ctx.fileCheckpoints = checkpoints;
            await checkpoints.beginTurn({prompt: "create"});
            checkpoints.afterWrite = async () => { throw new Error("after record unavailable"); };
            const result = await createToolRuntime().executeTool("write_file", '{"path":"nested/file.txt","content":"created"}', ctx, "create");
            expect(result.outcome).toBe("ok");
            expect(result.uiData).toMatchObject({type: "file_change"});
            expect(result.modelContent).toContain("after record unavailable");
            expect(await readFile(`${cwd}/nested/file.txt`, "utf8")).toBe("created");
            expect((await checkpoints.listCheckpoints())[0]?.mutations[0]?.after).toBeUndefined();
            expect(await readdir(`${cwd}/nested`)).toEqual(["file.txt"]);
        });
    });

    test.each(["same-content replacement", "symlink"])("checkpoint wait rejects %s", async replacement => {
        await withTempProject(async (cwd, storage) => {
            await writeFile(`${cwd}/file.txt`, "before\n");
            await writeFile(`${cwd}/external.txt`, "before\n");
            const ctx = createTestContext(cwd);
            const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "replace", enabled: true});
            ctx.fileCheckpoints = runtime;
            await runtime.beginTurn({prompt: "edit"});
            const tools = createToolRuntime();
            await executeDeliveredTool(tools, "read_file", '{"path":"file.txt"}', ctx, "read");
            const before = runtime.beforeWrite.bind(runtime);
            runtime.beforeWrite = async input => {
                const result = await before(input);
                await rename(`${cwd}/file.txt`, `${cwd}/original.txt`);
                if (replacement === "symlink") await symlink(`${cwd}/external.txt`, `${cwd}/file.txt`);
                else await writeFile(`${cwd}/file.txt`, "before\n");
                return result;
            };
            const result = await tools.executeTool("edit_file", JSON.stringify(calls[0].input), ctx, "edit");
            expect(result.outcome).toBe("failed");
            expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("before\n");
            expect(await readFile(`${cwd}/external.txt`, "utf8")).toBe("before\n");
            expect((await readdir(cwd)).filter(name => name.startsWith(".pillar-write-"))).toEqual([]);
        });
    });

    test("a new file appearing during capture is not overwritten", async () => {
        await withTempProject(async (cwd, storage) => {
            const ctx = createTestContext(cwd);
            const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: "new", enabled: true});
            ctx.fileCheckpoints = runtime;
            await runtime.beginTurn({prompt: "create"});
            const before = runtime.beforeWrite.bind(runtime);
            runtime.beforeWrite = async input => {
                const result = await before(input);
                await writeFile(`${cwd}/file.txt`, "external create");
                return result;
            };
            const result = await createToolRuntime().executeTool("write_file", JSON.stringify(calls[1].input), ctx, "create");
            expect(result.outcome).toBe("failed");
            expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("external create");
        });
    });

    test("same-path writers share ordering but never share observation authority", async () => {
        await withTempProject(async (cwd, storage) => {
            await writeFile(`${cwd}/file.txt`, "before\n");
            await chmod(`${cwd}/file.txt`, 0o751);
            const coordinator = new FileCommitCoordinator();
            const contexts = [createTestContext(cwd, {fileCommits: coordinator}), createTestContext(cwd, {fileCommits: coordinator})];
            const tools = createToolRuntime();
            const order: string[] = [];
            let release!: () => void;
            const gate = new Promise<void>(done => { release = done; });
            let entered!: () => void;
            const ready = new Promise<void>(done => { entered = done; });
            for (let index = 0; index < contexts.length; index++) {
                const ctx = contexts[index]!;
                const runtime = createFileCheckpointRuntime({storage, cwd, sessionId: `writer-${index}`, enabled: true});
                ctx.fileCheckpoints = runtime;
                await runtime.beginTurn({prompt: "edit"});
                await executeDeliveredTool(tools, "read_file", '{"path":"file.txt"}', ctx, `read-${index}`);
                const before = runtime.beforeWrite.bind(runtime);
                const after = runtime.afterWrite.bind(runtime);
                runtime.beforeWrite = async input => {
                    order.push(`before-${index}`);
                    if (index === 0) { entered(); await gate; }
                    return before(input);
                };
                runtime.afterWrite = async input => { order.push(`after-${index}`); return after(input); };
            }
            const first = tools.executeTool("edit_file", JSON.stringify(calls[0].input), contexts[0]!, "first");
            await ready;
            const second = tools.executeTool("write_file", JSON.stringify(calls[1].input), contexts[1]!, "second");
            release();
            const results = await Promise.all([first, second]);
            expect(results.map(result => result.outcome)).toEqual(["ok", "failed"]);
            expect(order).toEqual(["before-0", "after-0"]);
            expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("after\n");
            expect((await lstat(`${cwd}/file.txt`)).mode & 0o777).toBe(0o751);
            expect((await readdir(cwd)).filter(name => name.startsWith(".pillar-write-"))).toEqual([]);
        });
    });
    for (const call of calls) {
        test(`${call.name} preserves an external save during checkpoint capture`, async () => {
            await withTempProject(async (cwd, storage) => {
                await writeFile(`${cwd}/file.txt`, "before\n");
                const ctx = createTestContext(cwd);
                const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "external", enabled: true});
                ctx.fileCheckpoints = checkpoints;
                await checkpoints.beginTurn({prompt: "change"});
                const rt = createToolRuntime();
                await executeDeliveredTool(rt, "read_file", '{"path":"file.txt"}', ctx, "read");
                const before = checkpoints.beforeWrite.bind(checkpoints);
                checkpoints.beforeWrite = async input => {
                    const result = await before(input);
                    await writeFile(`${cwd}/file.txt`, "external save\n");
                    return result;
                };
                const result = await rt.executeTool(call.name, JSON.stringify(call.input), ctx, "change");
                expect(result.outcome).toBe("failed");
                expect(result.uiData).toBeUndefined();
                expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("external save\n");
            });
        });

        test(`${call.name} does not commit if cancellation arrives before capture finishes`, async () => {
            await withTempProject(async (cwd, storage) => {
                await writeFile(`${cwd}/file.txt`, "before\n");
                const controller = new AbortController();
                const ctx = createTestContext(cwd, {signal: controller.signal});
                const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "cancel", enabled: true});
                ctx.fileCheckpoints = checkpoints;
                await checkpoints.beginTurn({prompt: "change"});
                const rt = createToolRuntime();
                await executeDeliveredTool(rt, "read_file", '{"path":"file.txt"}', ctx, "read");
                const before = checkpoints.beforeWrite.bind(checkpoints);
                checkpoints.beforeWrite = async input => {
                    const result = await before(input);
                    controller.abort("user-cancel");
                    return result;
                };
                const result = await rt.executeTool(call.name, JSON.stringify(call.input), ctx, "change");
                expect(result.outcome).toBe("interrupted");
                expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("before\n");
            });
        });
    }

    test("post-commit cancellation retains FileChange and paired results", async () => {
        await withTempProject(async (cwd, storage) => {
            await writeFile(`${cwd}/file.txt`, "before\n");
            const controller = new AbortController();
            const ctx = createTestContext(cwd, {signal: controller.signal});
            const checkpoints = createFileCheckpointRuntime({storage, cwd, sessionId: "after", enabled: true});
            ctx.fileCheckpoints = checkpoints;
            await checkpoints.beginTurn({prompt: "change"});
            const rt = createToolRuntime();
            await executeDeliveredTool(rt, "read_file", '{"path":"file.txt"}', ctx, "read");
            const after = checkpoints.afterWrite.bind(checkpoints);
            checkpoints.afterWrite = async input => {
                const result = await after(input);
                controller.abort("user-cancel");
                return result;
            };
            const toolCalls: ToolCall[] = ["one", "two"].map(id => ({id, type: "function",
                function: {name: "edit_file", arguments: JSON.stringify(calls[0].input)}}));
            const history: Message[] = [{role: "assistant", content: "", tool_calls: toolCalls}];
            const events: AgentEvent[] = [];
            const sdkEvents: ThreadEventPayload[] = [];
            const adapter = new SDKEventAdapter("turn", event => { sdkEvents.push(event); });
            const batch = await executeToolCallBatch({toolCalls, history, ctx, turnId: "turn",
                onEvent: event => { events.push(event); adapter.handleAgentEvent(event); },
                executeTool: rt.executeTool, isToolConcurrencySafe: rt.isConcurrencySafe});
            adapter.finish("interrupted");
            expect(batch.status).toBe("interrupted");
            expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("after\n");
            expect(events.find(event => event.type === "tool_call_end" && event.toolCallId === "one"))
                .toMatchObject({outcome: "ok", uiData: {type: "file_change"}});
            expect(history.filter(item => item.role === "tool")).toHaveLength(2);
            expect(sdkEvents.filter(event => event.type === "item.completed" && event.item.type === "file_change")).toHaveLength(1);
            expect(sdkEvents.find(event => event.type === "item.completed" && event.item.id === "tool:one"))
                .toMatchObject({item: {status: "completed", outcome: "ok"}});
            expect((await checkpoints.listCheckpoints())[0]?.mutations[0]?.after?.kind).toBe("regular");
        });
    });

    test("stale Delete after approval reports failure to Hooks", async () => {
        await withTempProject(async cwd => {
            await writeFile(`${cwd}/file.txt`, "before\n");
            const events: string[] = [];
            const ctx = createTestContext(cwd, {permissionMode: "readOnly", canUseTool: async () => {
                await writeFile(`${cwd}/file.txt`, "external\n");
                return {behavior: "allow"};
            }});
            const rt = createToolRuntime({hooks: {enabled: true, issues: [], async execute(input) {
                events.push(input.hook_event_name);
                return {blocked: false, additionalContexts: [], executions: []};
            }}});
            await executeDeliveredTool(rt, "read_file", '{"path":"file.txt"}', ctx, "read");
            events.length = 0;
            const result = await rt.executeTool("delete_file", '{"path":"file.txt"}', ctx, "delete");
            expect(result.outcome).toBe("failed");
            expect(events).toEqual(["PreToolUse", "PostToolUseFailure"]);
            expect(await readFile(`${cwd}/file.txt`, "utf8")).toBe("external\n");
        });
    });
});
