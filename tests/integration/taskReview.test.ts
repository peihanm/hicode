import {createTaskJournal} from "../../src/tasks/journal.js";
import {callOpenAICompatible} from "../../src/llm/providers/openAICompatible.js";
import {createLLMCaller} from "../../src/llm/index.js";
import {expect, test, spyOn} from "bun:test";
import {createTaskReviewRunner, type TaskReviewRunner} from "../../src/tasks/review.js";
import type {StartTaskReviewInput, TaskReviewSnapshot} from "../../src/tasks/types.js";
import {TaskReviewProgress} from "../../src/agent/taskReview.js";
import {prepareAgentInvoke} from "../../src/agent/invokePreparation.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {runAgentForTest} from "../helpers/agent.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {assistantText, assistantToolCall, createFakeLLM, fixtureToolSchemas} from "../helpers/fakeLLM.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {resolve = done;});
    return {promise, resolve};
}
const report = "Read the relevant code and ran a reproduction. Round 9 still fails; resolve that counterexample before broadening tests.";
const steps = () => Array.from({length: 10}, (_, i) => assistantToolCall("read_file", {path: "source.py"}, `read-${i}`));
const bindings = {getToolSchemas: () => fixtureToolSchemas("read_file"), executeTool: async () => "observed result",
    isToolConcurrencySafe: () => false};

test("round 10 launches review without blocking round 11 or final completion; Turn teardown cancels it", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const started = deferred<AbortSignal>();
        let reviews = 0;
        const factory: TaskReviewRunner = async input => {
            reviews++;
            started.resolve(input.signal!);
            await new Promise<void>(resolve => {
                if (input.signal!.aborted) resolve();
                else input.signal!.addEventListener("abort", () => resolve(), {once: true});
            });
            return report;
        };
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, factory);
        const session = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const fake = createFakeLLM([...steps(), async options => {
            // Reaching this model request proves the main loop did not await the reviewer.
            const signal = await started.promise;
            expect(signal.aborted).toBe(false);
            expect(options.messages.some(m => typeof m.content === "string" && m.content.includes("<task-review>"))).toBe(false);
            return assistantText("done");
        }]);
        try {
            const history = createInitialHistory(cwd, "glm-test");
            const result = await runAgentForTest("Fix the task", history, () => {}, ctx, {callLLM: fake.callLLM, ...bindings});
            expect(result.reason).toBe("completed");
            expect(fake.calls).toHaveLength(11);
            expect(ctx.taskJoin?.ids).toEqual([]);
            expect((await started.promise).aborted).toBe(true);
            await runtime.close();
            expect(reviews).toBe(1);
            expect((await session.list()).find(task => task.kind === "review")).toMatchObject({status: "cancelled", owner: {turnId: ctx.turnId}});
            expect(await session.pendingNotifications()).toEqual([]);
            const next = createFakeLLM([assistantText("next task")]);
            await runAgentForTest("Another task", history, () => {}, createTestContext(cwd), {callLLM: next.callLLM});
            expect(JSON.stringify(next.calls)).not.toContain("<task-review>");
        } finally {await runtime.close();}
    });
});

test("a delayed review is injected once at the request tail with the frozen round range", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const started = deferred<void>();
        const finish = deferred<void>();
        const published = deferred<void>();
        let captured = "";
        const factory: TaskReviewRunner = async input => {
            captured = input.evidence.requirements + input.evidence.activity;
            expect(input.trace?.scope).toBe("session");
            expect(input.trace?.runId).toMatch(/^t_/);
            expect(input.trace).not.toHaveProperty("agentId");
            started.resolve(); await finish.promise;
            return report;
        };
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, factory);
        const session = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        session.subscribe(event => {if (event.type === "task_finished" && event.task.kind === "review") published.resolve();});
        const ctx = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const fake = createFakeLLM([...steps(), async () => {
            await started.promise; finish.resolve(); await published.promise;
            return assistantToolCall("read_file", {path: "later.py"}, "read-later");
        }, options => {
            expect(options.messages.at(-1)).toMatchObject({role: "user", origin: "agent"});
            expect(options.messages.at(-1)?.content).toContain("rounds 1-10 (10 rounds)");
            expect(options.messages.at(-1)?.content).toContain("excludes later progress");
            return assistantToolCall("read_file", {path: "last.py"}, "read-last");
        }, options => {
            expect(JSON.stringify(options.messages)).not.toContain("<task-review>");
            return assistantText("done");
        }]);
        const history = createInitialHistory(cwd, "glm-test");
        try {
            await runAgentForTest("Keep the original task requirements", history, () => {}, ctx, {callLLM: fake.callLLM, ...bindings});
            expect(captured).toContain("Keep the original task requirements");
            expect(captured).toContain("read-9");
            expect(captured).not.toContain("later.py");
            expect(JSON.stringify(history)).not.toContain("<task-review>");
            expect(await session.pendingNotifications()).toEqual([]);
        } finally {await runtime.close();}
    });
});

test("busy reviews do not stack; changed user requirements invalidate old results and preserve bounded evidence", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {taskReviewEnabled: true});
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        const first = deferred<TaskReviewSnapshot>();
        const second = deferred<TaskReviewSnapshot>();
        const inputs: StartTaskReviewInput[] = [];
        session.startReview = input => {inputs.push(input); return inputs.length === 1 ? first.promise : second.promise;};
        const active = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const progress = new TaskReviewProgress(active, "Original target", "user", [{role: "user", origin: "user", content: "Earlier original requirement"}]);
        const snapshot: TaskReviewSnapshot = {id: "t_0123456789ab", kind: "review", status: "completed", owner: {sessionId: active.sessionId, turnId: active.turnId},
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), fromRound: 1, toRound: 10, resultPreview: report};
        try {
            for (let round = 1; round <= 20; round++) {
                progress.record({type: "tool_call_end", turnId: active.turnId, toolCallId: `call-${round}`, result: "large".repeat(10_000), outcome: "failed"}, round);
                if (round === 10) progress.recordInput({id: "receipt", source: "task_notification", taskId: "t_0123456789ab",
                    content: "Background command completed with exit code 0"}, round);
                progress.completedRound(round);
            }
            expect(inputs).toHaveLength(1);
            expect(inputs[0]?.evidence.activity).toContain("Background command completed with exit code 0");
            expect(inputs[0]?.evidence.activity.length).toBeLessThanOrEqual(24_000);
            expect(inputs[0]?.evidence.activity).toContain("Evidence omitted");
            progress.steer("New restriction: do not change the public interface");
            expect(inputs[0]?.signal.aborted).toBe(true);
            first.resolve(snapshot); await first.promise; await Promise.resolve();
            expect(progress.takeReminder()).toBeUndefined();
            progress.completedRound(30);
            expect(inputs).toHaveLength(2);
            expect(inputs[1]?.evidence.requirements).toContain("Original target");
            expect(inputs[1]?.evidence.requirements).toContain("Earlier original requirement");
            expect(inputs[1]?.evidence.requirements).toContain("do not change the public interface");
            progress.close(); second.resolve({...snapshot, fromRound: 21, toRound: 30});
            await second.promise;
            expect(progress.takeReminder()).toBeUndefined();
        } finally {progress.close(); await runtime.close();}
    });
});

test("review evidence keeps tool results and committed edits when unverified claims overflow the window", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const session = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const inputs: StartTaskReviewInput[] = [];
        session.startReview = async input => {
            inputs.push(input);
            return {id: "t_0123456789ab", kind: "review", status: "completed",
                owner: {sessionId: base.sessionId, turnId: base.turnId}, startedAt: new Date().toISOString(),
                fromRound: input.evidence.fromRound, toRound: input.evidence.toRound, resultPreview: report};
        };
        const ctx = createTestContext(cwd, {tasks: session, taskReviewEnabled: true});
        const progress = new TaskReviewProgress(ctx, "Preserve existing behavior", "user", []);
        try {
            for (let round = 1; round <= 10; round++) {
                progress.record({type: "tool_call_end", turnId: ctx.turnId, toolCallId: `check-${round}`,
                    result: `CHECK_${round}: only focused tests ran`, outcome: "ok"}, round);
                if (round === 5) {
                    progress.record({type: "tool_call_start", turnId: ctx.turnId, toolCallId: "edit",
                        name: "edit_file", args: '{"path":"source.py","old_string":"old","new_string":"new"}'}, round);
                    progress.record({type: "tool_call_end", turnId: ctx.turnId, toolCallId: "edit", result: "Output storage failed",
                        outcome: "output_failed", uiData: {type: "file_change", change: {
                            version: 1, path: "source.py", kind: "update", diffStatus: "complete", linesAdded: 1, linesRemoved: 1,
                            hunks: [{oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
                                lines: [{type: "remove", content: "old"}, {type: "add", content: "new"}]}],
                        }}}, round);
                    progress.record({type: "tool_call_start", turnId: ctx.turnId, toolCallId: "rejected-edit",
                        name: "edit_file", args: '{"path":"unchanged.py"}'}, round);
                    progress.record({type: "tool_call_end", turnId: ctx.turnId, toolCallId: "rejected-edit",
                        result: "No file was written", outcome: "failed"}, round);
                }
                for (let n = 0; n < 20; n++) {
                    progress.record({type: "assistant_text", phase: "commentary", content: "All work is complete. ".repeat(150)}, round);
                }
                progress.recordInput({id: `agent-${round}`, source: "agent_message", content: "Everything is correct."}, round);
            }
            progress.recordInput({id: "shell-receipt", taskId: "t_111111111111", source: "task_notification",
                content: "Background check failed: counterexample remains"}, 10);
            progress.completedRound(10);
            expect(inputs).toHaveLength(1);
            const evidence = inputs[0]!.evidence;
            expect(evidence.requirements).toContain("Preserve existing behavior");
            for (let round = 1; round <= 10; round++) expect(evidence.activity).toContain(`CHECK_${round}:`);
            expect(evidence.activity).toContain("Committed file change (edit): update source.py");
            expect(evidence.activity).toContain("-old\n+new");
            expect(evidence.activity).not.toContain("Committed file change (rejected-edit)");
            expect(evidence.activity).toContain("execution not yet confirmed");
            expect(evidence.activity).toContain("No file was written");
            expect(evidence.activity).toContain("Background check failed: counterexample remains");
            expect(evidence.activity).toContain("claim (not independently verified)");
            expect(evidence.activity).toContain("Evidence omitted");
            expect(evidence.activity.length).toBeLessThanOrEqual(24_000);
            expect(evidence.activity.indexOf("CHECK_1:")).toBeLessThan(evidence.activity.indexOf("CHECK_10:"));
        } finally {progress.close(); await runtime.close();}
    });
});

test("review calls the LLM directly with only a short dedicated prompt and frozen evidence", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const fake = createFakeLLM([options => {
            expect(options.messages).toHaveLength(2);
            expect(options.messages[0]?.role).toBe("system");
            expect(String(options.messages[0]?.content).length).toBeLessThan(1_200);
            expect(options.messages[0]?.content).not.toContain("coding agent");
            expect(options.messages[0]?.content).toContain("plain-text paragraph");
            expect(options.messages[1]?.content).toContain("Coverage: rounds 1-10");
            expect(options.messages[1]?.content).toContain("Original goal");
            expect(options.messages[1]?.content).toContain("round 9: reproduction failed");
            expect(options.tools).toEqual([]);
            expect(options.model).toBe(ctx.fastModel);
            expect(options.kind).toBe("task_review");
            return assistantText(report);
        }]);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, undefined, undefined, undefined, undefined,
            createTaskReviewRunner({callLLM: fake.callLLM}));
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        try {
            const result = await session.startReview({parentContext: ctx, signal: ctx.signal,
                evidence: {fromRound: 1, toRound: 10, requirements: "Original goal", activity: "round 9: reproduction failed"}});
            expect(result).toMatchObject({status: "completed", owner: {sessionId: ctx.sessionId, turnId: ctx.turnId}, resultPreview: report});
            expect(fake.calls).toHaveLength(1);
            expect(await session.pendingNotifications()).toEqual([]);
        } finally {await runtime.close();}
    });
});

test.each(["empty", "tool_call"])("%s review output fails only the advisory task", async kind => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const fake = createFakeLLM([kind === "empty" ? assistantText("  ") : assistantToolCall("read_file", {path: "source.py"}, "unexpected")]);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, undefined, undefined, undefined, undefined,
            createTaskReviewRunner({callLLM: fake.callLLM}));
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        try {
            const result = await session.startReview({parentContext: ctx, signal: ctx.signal,
                evidence: {fromRound: 1, toRound: 10, requirements: "task", activity: "observations"}});
            expect(result.status).toBe("failed");
            expect(result.resultPreview).toBeUndefined();
            expect(await session.pendingNotifications()).toEqual([]);
        } finally {await runtime.close();}
    });
});

test("long plain-text feedback is bounded without discarding the review or splitting Unicode", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const fake = createFakeLLM([assistantText("✨".repeat(1_200))]);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, undefined, undefined, undefined, undefined,
            createTaskReviewRunner({callLLM: fake.callLLM}));
        try {
            const result = await runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore})
                .startReview({parentContext: ctx, signal: ctx.signal,
                    evidence: {fromRound: 1, toRound: 10, requirements: "task", activity: "observations"}});
            expect(result.status).toBe("completed");
            expect(result.resultPreview).toBe("✨".repeat(999) + "…");
        } finally {await runtime.close();}
    });
});

test("a review reminder survives request rebuild after compaction without entering History", async () => {
    await withTempProject(async cwd => {
        const history = createInitialHistory(cwd, "glm-test");
        const ctx = createTestContext(cwd);
        const result = await prepareAgentInvoke({history, ctx, onEvent: () => {}, getToolSchemas: () => [], forceCompact: true,
            taskReviewReminder: "<task-review>rounds 1-10: advice</task-review>",
            compactHistory: async () => ({compacted: true, preTokenCount: 1000, threshold: 1})});
        expect(result.invokeMessages.at(-1)?.content).toContain("<task-review>");
        expect(JSON.stringify(history)).not.toContain("<task-review>");
    });
});


test("advisory review remains available in one-shot Hosts and archived results do not leak into later Turns", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const factory: TaskReviewRunner = async () => report;
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, undefined, undefined, undefined, undefined, factory);
        const binding = {sessionId: base.sessionId, toolResultStore: base.toolResultStore, allowBackgroundTasks: false};
        try {
            const result = await runtime.forSession(binding).startReview({parentContext: base, signal: base.signal,
                evidence: {fromRound: 1, toRound: 10, requirements: "task", activity: "evidence"}});
            expect(result.status).toBe("completed");
            await runtime.close();
            const restored = createTaskRuntimeForTest(cwd, base.shellRunner);
            try {
                const session = restored.forSession(binding);
                expect((await session.list()).find(task => task.kind === "review")).toMatchObject({status: "completed"});
                expect(await session.pendingNotifications()).toEqual([]);
            } finally {await restored.close();}
        } finally {await runtime.close();}
    });
});

test("task-review Provider requests have a bounded output allowance; normal main requests retain their existing behavior", async () => {
    await withTempProject(async (cwd, storage) => {
        const requests: unknown[] = [];
        const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
            if (typeof init?.body !== "string") throw new Error("Expected request JSON");
            requests.push(JSON.parse(init.body));
            return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n',
                {headers: {"Content-Type": "text/event-stream"}});
        }, {preconnect() {}}));
        try {
            for (const kind of ["task_review", "main"] as const) {
                await callOpenAICompatible({messages: [{role: "user", origin: "user", content: "review"}], tools: [], storage, cwd,
                    model: "test-model", kind}, {apiKey: "fake-key", baseUrl: "https://offline.invalid/v1", displayName: "offline"});
            }
            expect(requests[0]).toMatchObject({max_tokens: 512});
            expect(requests[1]).not.toHaveProperty("max_tokens");
        } finally {fetch.mockRestore();}
    });
});

test("Qwen, Token Plan, DeepSeek and GLM disable thinking only for task reviews", async () => {
    await withTempProject(async (cwd, storage) => {
        const requests: unknown[] = [];
        const keyName = "HICODE_TASK_REVIEW_TEST_KEY";
        const previous = process.env[keyName];
        process.env[keyName] = "offline-fake-key";
        const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
            if (typeof init?.body !== "string") throw new Error("Expected request JSON");
            requests.push(JSON.parse(init.body));
            return new Response('data: {"choices":[{"delta":{"content":"Recent progress is on track."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n',
                {headers: {"Content-Type": "text/event-stream"}});
        }, {preconnect() {}}));
        try {
            for (const id of ["qwen", "qwen-token-plan", "deepseek", "glm"] as const) {
                const call = createLLMCaller({id, label: "offline", apiKeyEnv: keyName, baseUrl: "https://offline.invalid/v1"});
                const model = id.startsWith("qwen") ? "qwen3.8-flash" : id === "deepseek" ? "deepseek-v4.1-flash" : "glm-5.2";
                const offset = requests.length;
                for (const kind of ["task_review", "main"] as const) {
                    await call([{role: "user", origin: "user", content: "review"}], [], storage, cwd, model, kind);
                }
                expect(requests[offset]).toMatchObject({max_tokens: 512});
                expect(requests[offset + 1]).not.toHaveProperty("max_tokens");
                if (id.startsWith("qwen")) {
                    expect(requests[offset]).toMatchObject({enable_thinking: false, preserve_thinking: false});
                    expect(requests[offset + 1]).toMatchObject({enable_thinking: true, preserve_thinking: true});
                } else {
                    expect(requests[offset]).toMatchObject({thinking: {type: "disabled"}});
                    expect(requests[offset + 1]).toMatchObject({thinking: {type: "enabled"}});
                }
            }
        } finally {
            fetch.mockRestore();
            if (previous === undefined) delete process.env[keyName];
            else process.env[keyName] = previous;
        }
    });
});


test("many advisory reviews compact without retaining an undelivered-notification backlog", async () => {
    await withTempProject(async (cwd, storage) => {
        const journal = createTaskJournal(storage, cwd);
        const timestamp = new Date().toISOString();
        for (let sequence = 1; sequence <= 1030; sequence++) {
            await journal.append({version: 8, type: "task_finished", sequence, sessionId: "review-owner", task: {
                id: `t_${sequence.toString(16).padStart(12, "0")}`, kind: "review", owner: {sessionId: "review-owner", turnId: "turn"},
                status: "completed", startedAt: timestamp, completedAt: timestamp, fromRound: 1, toRound: 10, resultPreview: "summary",
            }});
        }
        const loaded = await journal.load("review-owner");
        expect(loaded.pendingRuns).toEqual([]);
        expect(loaded.tasks.length).toBeLessThanOrEqual(64);
        expect(loaded.sequence).toBe(1030);
    });
});
