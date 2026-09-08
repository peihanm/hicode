import {contentText} from "../../src/images/content.js";
import {describe, expect, test} from "bun:test";
import {readFile, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {createCompactState} from "../../src/context/index.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import type {AgentRuntime} from "../../src/runtime/agentRuntime.js";
import {createSessionId, loadSession} from "../../src/session/index.js";
import {Pillar} from "../../src/sdk/index.js";
import {collectTurnResult} from "../../src/sdk/resultCollector.js";
import {createSDKThread} from "../../src/sdk/thread.js";
import type {ThreadEvent, InteractionRequest} from "../../src/sdk/protocol.js";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import type {SandboxAskCallback} from "@anthropic-ai/sandbox-runtime";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import type {SubagentRunner} from "../../src/subagents/types.js";
import {runAgentForTest} from "../helpers/agent.js";
import {
    assistantText,
    assistantToolCall,
    createFakeLLM,
} from "../helpers/fakeLLM.js";
import {
    createTestRuntimeResources,
    createTestRootConfiguration,
    createTestSettings,
} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

function createFakeAgentRuntime(
    fake: ReturnType<typeof createFakeLLM>
): AgentRuntime {
    return {
        runAgent: (
            prompt,
            history,
            onEvent,
            ctx,
            inputChannel,
            options
        ) => runAgentForTest(prompt, history, onEvent, ctx, {
            ...options,
            callLLM: fake.callLLM,
            inputChannel,
        }),
        createSubagentRunner: () => {
            const runner: SubagentRunner = async () => {
                throw new Error("SDK 测试未配置子 Agent");
            };
            return runner;
        },
        createSubagentThread: (options) => ({
            agentId: options.agentId,
            async run() {
                throw new Error("SDK 测试未配置子 Agent");
            },
        }),
        compactHistory: async () => ({
            compacted: false,
            preTokenCount: 0,
            threshold: Number.MAX_SAFE_INTEGER,
        }),
    };
}

describe("TypeScript SDK", () => {
    test("sequential Threads sharing Root do not share file observations", async () => {
        await withTempProject(async (cwd, storage) => {
            await writeFile(`${cwd}/owned.txt`, "original\n");
            const fake = createFakeLLM([
                assistantToolCall("read_file", {path: "owned.txt"}, "read-a"), assistantText("read"),
                assistantToolCall("write_file", {path: "owned.txt", content: "overwritten"}, "write-b"),
                assistantText("写入失败，未完成：需要先读取文件，当前没有修改。"),
                assistantText("写入失败，未完成：尚未读取原文，当前没有修改。"),
            ]);
            const resources = createTestRuntimeResources(cwd, {storage, agentRuntime: createFakeAgentRuntime(fake)});
            const open = () => createSDKThread({resources,
                seed: {sessionId: createSessionId(), history: createInitialHistory(cwd, resources.model), compactState: createCompactState()},
                state: {todos: [], permissionMode: "bypassPermissions", collaborationMode: "build", uiEvents: []},
                resumed: false, onClose() {},
            });
            try {
                const first = await open();
                try { await first.run("read"); } finally { await first.close(); }
                const second = await open();
                try { await second.run("write without reading"); } finally { await second.close(); }
                expect(await readFile(`${cwd}/owned.txt`, "utf8")).toBe("original\n");
            } finally { await resources.close(); }
        });
    });
    test("真实 ToolRuntime 网络交互穿过 SDK Host，Session 授权跨 Turn 复用且无 elevated", async () => {
        await withTempProject(async (cwd, storage) => {
            let enabled = false;
            let ask: SandboxAskCallback | undefined;
            let wraps = 0;
            const createSandbox = createSandboxRuntimeFactory({
                isSupportedPlatform: () => true,
                isSandboxingEnabled: () => enabled,
                checkDependencies: () => ({errors: [], warnings: []}),
                async initialize(_config, callback) { enabled = true; ask = callback; },
                async wrapWithSandboxArgv(command, _shell, config) {
                    wraps++;
                    expect(config?.network?.allowedDomains).toEqual([]);
                    const allowed = await ask?.({host: "registry.example.test", port: 443});
                    return {argv: ["/bin/sh", "-c", allowed ? command : "exit 22"], env: {}};
                },
                annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
                cleanupAfterCommand() {},
                async reset() { enabled = false; },
            });
            const sandbox = await createSandbox({cwd, storage, settings: {
                enabled: true, filesystem: {denyRead: [], denyWrite: []},
                network: {allowedDomains: [], allowLocalBinding: false},
            }});
            const fake = createFakeLLM([
                assistantToolCall("bash", {command: "printf first"}, "network-sdk-1"),
                assistantText("first complete"),
                assistantToolCall("bash", {command: "printf second"}, "network-sdk-2"),
                assistantText("second complete"),
            ]);
            const resources = createTestRuntimeResources(cwd, {
                storage, sandbox, shellRunner: createShellRunner(sandbox, testChildEnvironment),
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const interactions: InteractionRequest[] = [];
            const thread = await createSDKThread({
                resources,
                seed: {sessionId: createSessionId(), history: createInitialHistory(cwd, resources.model), compactState: createCompactState()},
                state: {todos: [], permissionMode: "default", collaborationMode: "build", uiEvents: []},
                resumed: false,
                host: {async onInteraction(request) {
                    interactions.push(request);
                    return {behavior: "allow", networkScope: "session"};
                }},
                onClose() {},
            });
            try {
                const first = await thread.run("first");
                const second = await thread.run("second");
                expect(first.finalResponse).toBe("first complete");
                expect(second.finalResponse).toBe("second complete");
                expect(interactions).toHaveLength(1);
                expect(interactions[0]).toMatchObject({
                    kind: "permission", toolName: "bash",
                    networkAccess: {host: "registry.example.test", port: 443},
                });
                expect(first.items.some((item) => item.type === "interaction" && item.status === "completed")).toBe(true);
                expect(wraps).toBe(2);
            } finally {
                await thread.close();
                await resources.close();
                await sandbox.close();
            }
        });
    });

    test("公开 Pillar 生命周期可以创建 Thread 并幂等关闭", async () => {
        await withTempProject(async (cwd, storage) => {
            const pillar = await Pillar.create({
                configuration: createTestRootConfiguration(
                    cwd,
                    createTestSettings(),
                    storage
                ),
            });
            const thread = await pillar.startThread({
                permissionMode: "default",
        collaborationMode: "build",
            });

            expect(thread.getInfo()).toMatchObject({
                id: thread.id,
                cwd,
                permissionMode: "default",
        collaborationMode: "build",
                resumed: false,
            });
            await expect(pillar.startThread()).rejects.toMatchObject({
                code: "thread_already_open",
            });

            await thread.close();
            const next = await pillar.startThread();
            await next.close();
            await pillar.close();
            await pillar.close();
        });
    });

    test("Root 初始化期的 MCP 与 Hook 审批复用 Host callback", async () => {
        await withTempProject(async (cwd, storage) => {
            const fixture = resolve(
                import.meta.dir,
                "../fixtures/mcp/stdioServer.ts"
            );
            await writeFile(join(cwd, ".mcp.json"), JSON.stringify({
                mcpServers: {
                    sdk_fixture: {
                        command: process.execPath,
                        args: [fixture],
                    },
                },
            }));
            const defaults = createTestSettings();
            const settings = createTestSettings({
                hooks: {
                    ...defaults.hooks,
                    SessionStart: [{
                        source: "project",
                        path: join(cwd, ".pillar", "settings.json"),
                        hooks: [{type: "command", purpose: "observe", command: "true"}],
                    }],
                },
            });
            const interactionKinds: string[] = [];

            const pillar = await Pillar.create({
                configuration: createTestRootConfiguration(
                    cwd,
                    settings,
                    storage
                ),
                host: {
                    async onInteraction(request) {
                        interactionKinds.push(request.kind);
                        return {behavior: "allow", persistence: "once"};
                    },
                },
            });
            try {
                const thread = await pillar.startThread();
                expect(interactionKinds).toEqual([
                    "mcp_approval",
                    "hook_trust",
                ]);
                expect(thread.getInfo().mcpServers).toEqual([
                    expect.objectContaining({
                        name: "sdk_fixture",
                        status: "connected",
                    }),
                ]);
                await thread.close();
            } finally {
                await pillar.close();
            }
        });
    });

    test("同一 Thread 连续 run 复用 History 和单调事件序号", async () => {
        await withTempProject(async (cwd, storage) => {
            const fake = createFakeLLM([
                assistantText("第一轮完成"),
                (call) => {
                    expect(call.messages).toEqual(expect.arrayContaining([
                        {role: "user", content: "第一轮"},
                        {role: "assistant", content: "第一轮完成"},
                        {role: "user", content: "第二轮"},
                    ]));
                    return assistantText("第二轮完成");
                },
            ]);
            const resources = createTestRuntimeResources(cwd, {
                storage,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const thread = await createSDKThread({
                resources,
                seed: {
                    sessionId: createSessionId(),
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                onClose() {},
            });

            try {
                const first = await thread.run("第一轮");
                const second = await thread.run("第二轮");

                expect(first.finalResponse).toBe("第一轮完成");
                expect(first.usage).toEqual({
                    inputTokens: 12,
                    outputTokens: 4,
                    totalTokens: 16,
                    estimated: false,
                });
                expect(second.finalResponse).toBe("第二轮完成");
                expect(first.threadId).toBe(second.threadId);
                expect(fake.calls).toHaveLength(2);
            } finally {
                await thread.close();
                await resources.close();
            }
        });
    });

    test("runStreamed 输出统一 Item 生命周期并通过 Host 完成显式 ask 写权限", async () => {
        await withTempProject(async (cwd, storage) => {
            const fake = createFakeLLM([
                assistantToolCall(
                    "write_file",
                    {path: "sdk-output.txt", content: "hello sdk"},
                    "sdk-write",
                    "准备写入 SDK 测试文件。"
                ),
                (call) => {
                    const result = call.messages.find(
                        (message) =>
                            message.role === "tool" &&
                            message.tool_call_id === "sdk-write"
                    );
                    expect(result?.content).toContain("sdk-output.txt");
                    return assistantText("写入完成");
                },
            ]);
            const settings = createTestSettings({
                permissions: {
                    defaultMode: "default",
                    additionalDirectories: [],
                    rules: {
                        allow: [],
                        ask: [{toolName: "write_file", source: "host"}],
                        deny: [],
                    },
                },
            });
            const resources = createTestRuntimeResources(cwd, {
                storage,
                settings,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const interactions: string[] = [];
            const thread = await createSDKThread({
                resources,
                seed: {
                    sessionId: createSessionId(),
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                host: {
                    async onInteraction(request) {
                        interactions.push(request.kind);
                        return {behavior: "allow"};
                    },
                },
                onClose() {},
            });

            try {
                const {events} = await thread.runStreamed("写入测试文件");
                const captured: ThreadEvent[] = [];
                for await (const event of events) captured.push(event);
                const result = await collectTurnResult(replay(captured));

                expect(result.finalResponse).toBe("写入完成");
                expect(result.items.filter(
                    (item) => item.type === "agent_message"
                )).toEqual([
                    expect.objectContaining({
                        type: "agent_message",
                        text: "准备写入 SDK 测试文件。",
                        phase: "commentary",
                    }),
                    expect.objectContaining({
                        type: "agent_message",
                        text: "写入完成",
                        phase: "final",
                    }),
                ]);
                expect(interactions).toEqual(["permission"]);
                expect(captured.map((event) => event.sequence)).toEqual(
                    captured.map((_, index) => index + 1)
                );
                expect(captured.some(
                    (event) =>
                        event.type === "item.completed" &&
                        event.item.type === "interaction" &&
                        event.item.status === "completed"
                )).toBe(true);
                expect(captured.some(
                    (event) =>
                        event.type === "item.completed" &&
                        event.item.type === "tool_call" &&
                        event.item.outcome === "ok"
                )).toBe(true);
                expect(captured.some(
                    (event) =>
                        event.type === "item.completed" &&
                        event.item.type === "file_change"
                )).toBe(true);
                expect(await readFile(`${cwd}/sdk-output.txt`, "utf8"))
                    .toBe("hello sdk");
            } finally {
                await thread.close();
                await resources.close();
            }
        });
    });

    test("Session 保存后可以恢复为同一 Thread 并继续对话", async () => {
        await withTempProject(async (cwd, storage) => {
            const fake = createFakeLLM([
                assistantText("已记录上下文"),
                (call) => {
                    expect(call.messages).toEqual(expect.arrayContaining([
                        {role: "assistant", content: "已记录上下文"},
                        {role: "user", content: "继续"},
                    ]));
                    return assistantText("恢复成功");
                },
            ]);
            const resources = createTestRuntimeResources(cwd, {
                storage,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const sessionId = createSessionId();
            const first = await createSDKThread({
                resources,
                seed: {
                    sessionId,
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                onClose() {},
            });
            await first.run("记住这轮");
            await first.close();

            const loaded = loadSession(storage, cwd, sessionId, resources.model);
            expect(loaded).not.toBeNull();
            const resumed = await createSDKThread({
                resources,
                seed: {
                    sessionId,
                    history: loaded!.history,
                    compactState:
                        loaded!.compactState ?? createCompactState(),
                    checkpointHead: loaded!.checkpointHead,
                    queuedInputs: loaded!.queuedInputs,
                    toolDiscovery: loaded!.toolDiscovery,
                    gitSession: loaded!.gitSession,
                },
                state: {
                    todos: loaded!.todos,
                    permissionMode: loaded!.permissionMode,
                    collaborationMode: loaded!.collaborationMode,
                    uiEvents: loaded!.uiEvents,
                },
                resumed: true,
                onClose() {},
            });

            try {
                const result = await resumed.run("继续");
                expect(resumed.id).toBe(sessionId);
                expect(result.finalResponse).toBe("恢复成功");
            } finally {
                await resumed.close();
                await resources.close();
            }
        });
    });

    test("同一 Thread 拒绝并发 Turn，前一轮完成后可以继续", async () => {
        await withTempProject(async (cwd, storage) => {
            let markStarted!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const fake = createFakeLLM([
                async () => {
                    markStarted();
                    await gate;
                    return assistantText("慢任务完成");
                },
                assistantText("后续完成"),
            ]);
            const resources = createTestRuntimeResources(cwd, {
                storage,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const thread = await createSDKThread({
                resources,
                seed: {
                    sessionId: createSessionId(),
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                onClose() {},
            });

            try {
                const first = thread.run("慢任务");
                await started;
                await expect(thread.run("并发任务")).rejects.toMatchObject({
                    code: "thread_busy",
                });
                release();
                expect((await first).finalResponse).toBe("慢任务完成");
                expect((await thread.run("后续任务")).finalResponse)
                    .toBe("后续完成");
            } finally {
                release();
                await thread.close();
                await resources.close();
            }
        });
    });

    test("已取消 signal 返回 interrupted，并且不会污染下一轮", async () => {
        await withTempProject(async (cwd, storage) => {
            const fake = createFakeLLM([assistantText("下一轮正常")]);
            const resources = createTestRuntimeResources(cwd, {
                storage,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const thread = await createSDKThread({
                resources,
                seed: {
                    sessionId: createSessionId(),
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                onClose() {},
            });
            const controller = new AbortController();
            controller.abort("user-cancel");

            try {
                const interrupted = await thread.run("取消本轮", {
                    signal: controller.signal,
                });
                expect(interrupted).toMatchObject({
                    stopReason: "interrupted",
                    abortReason: "user-cancel",
                    usage: null,
                });
                const next = await thread.run("继续执行");
                expect(next.finalResponse).toBe("下一轮正常");
            } finally {
                await thread.close();
                await resources.close();
            }
        });
    });

    test("关闭 Thread 会取消等待中的 Host interaction 并闭合 Turn", async () => {
        await withTempProject(async (cwd, storage) => {
            const fake = createFakeLLM([
                assistantToolCall(
                    "ask_user",
                    {
                        questions: [{
                            question: "是否继续",
                            options: [
                                {label: "是", description: "继续"},
                                {label: "否", description: "停止"},
                            ],
                        }],
                    },
                    "pending-question"
                ),
            ]);
            const resources = createTestRuntimeResources(cwd, {
                storage,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            let markInteractionStarted!: () => void;
            const interactionStarted = new Promise<void>((resolve) => {
                markInteractionStarted = resolve;
            });
            const never = new Promise<never>(() => {});
            const thread = await createSDKThread({
                resources,
                seed: {
                    sessionId: createSessionId(),
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                host: {
                    onInteraction() {
                        markInteractionStarted();
                        return never;
                    },
                },
                onClose() {},
            });

            const run = thread.run("先询问我");
            await interactionStarted;
            await thread.close();
            const result = await run;

            expect(result).toMatchObject({
                stopReason: "interrupted",
                abortReason: "shutdown",
            });
            expect(result.items).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: "interaction",
                    status: "interrupted",
                }),
            ]));
            await resources.close();
        });
    });

    test("ask_user 通过同一 interaction Item 和 Host callback 回答", async () => {
        await withTempProject(async (cwd, storage) => {
            const questionInput = {
                questions: [{
                    question: "选择方案",
                    options: [
                        {label: "A", description: "方案 A"},
                        {label: "B", description: "方案 B"},
                    ],
                }],
            };
            const fake = createFakeLLM([
                assistantToolCall("ask_user", questionInput, "sdk-question"),
                (call) => {
                    const result = call.messages.find(
                        (message) =>
                            message.role === "tool" &&
                            message.tool_call_id === "sdk-question"
                    );
                    expect(result?.content).toContain('"选择方案"="A"');
                    return assistantText("选择了 A");
                },
            ]);
            const resources = createTestRuntimeResources(cwd, {
                storage,
                agentRuntime: createFakeAgentRuntime(fake),
            });
            const seenKinds: string[] = [];
            const thread = await createSDKThread({
                resources,
                seed: {
                    sessionId: createSessionId(),
                    history: createInitialHistory(cwd, resources.model),
                    compactState: createCompactState(),
                },
                state: {
                    todos: [],
                    permissionMode: "default",
        collaborationMode: "build",
                    uiEvents: [],
                },
                resumed: false,
                host: {
                    async onInteraction(request) {
                        seenKinds.push(request.kind);
                        expect(request.kind).toBe("question");
                        return {
                            behavior: "allow",
                            answers: {"选择方案": "A"},
                        };
                    },
                },
                onClose() {},
            });

            try {
                const result = await thread.run("需要选择时询问我");
                expect(result.finalResponse).toBe("选择了 A");
                expect(seenKinds).toEqual(["question"]);
                expect(result.items.some(
                    (item) =>
                        item.type === "interaction" &&
                        item.request.kind === "question" &&
                        item.status === "completed"
                )).toBe(true);
            } finally {
                await thread.close();
                await resources.close();
            }
        });
    });
});

for (const action of ["resume", "return", "close", "abort"] as const) {
    test(`SDK 慢消费者 ${action} 不造成无界生产或资源死锁`, async () => {
        await withTempProject(async (cwd, storage) => {
            let produced = 0;
            let reached!: () => void;
            const ready = new Promise<void>(resolve => { reached = resolve; });
            const agentRuntime: AgentRuntime = {
                ...createFakeAgentRuntime(createFakeLLM([])),
                async runAgent(_prompt, history, onEvent, ctx) {
                    history.push({role: "user", content: "bounded stream"});
                    for (let index = 0; index < 400 && !ctx.signal.aborted; index++) {
                        if (index === 100) {
                            for (let draft = 0; draft < 1000; draft++) await onEvent({type: "assistant_draft", responseId: "slow-draft", text: String(draft), truncated: false});
                            await onEvent({type: "assistant_draft_end", responseId: "slow-draft", disposition: "discarded"});
                        }
                        await onEvent({type: "assistant_text", content: String(index), phase: "commentary"});
                        produced++;
                        if (produced === 100) reached();
                    }
                    history.push({role: "assistant", content: "done"});
                    return {reply: "done", reason: ctx.signal.aborted ? "interrupted" : "completed", iterations: 1};
                },
            };
            const resources = createTestRuntimeResources(cwd, {storage, agentRuntime});
            const thread = await createSDKThread({resources,
                seed: {sessionId: createSessionId(), history: createInitialHistory(cwd, resources.model), compactState: createCompactState()},
                state: {todos: [], permissionMode: "default", collaborationMode: "build", uiEvents: []},
                resumed: false, onClose() {},
            });
            const controller = new AbortController();
            try {
                const {events} = await thread.runStreamed("stream", {signal: controller.signal});
                const iterator = events[Symbol.asyncIterator]();
                await iterator.next();
                await ready;
                await new Promise(resolve => setTimeout(resolve, 10));
                expect(produced).toBeLessThan(150);
                if (action === "return") {
                    await iterator.return?.(undefined);
                } else if (action === "resume") {
                    const received: ThreadEvent[] = [];
                    while (true) {
                        const result = await iterator.next();
                        if (result.done) break;
                        received.push(result.value);
                    }
                    expect(produced).toBe(400);
                    expect(received.filter(event => event.type === "turn.draft").length).toBeLessThan(1000);
                    expect(received.filter(event => event.type === "turn.draft_end")).toHaveLength(1);
                    expect(received.every((event, index) => index === 0 || event.sequence === received[index - 1]!.sequence + 1)).toBe(true);
                    await expect(collectTurnResult(replay(received))).resolves.toBeDefined();
                    expect(received.filter(event => event.type === "item.started")).toHaveLength(400);
                    expect(received.filter(event => event.type === "item.completed")).toHaveLength(400);
                    expect(received.at(-1)?.type).toBe("turn.completed");
                } else {
                    if (action === "abort") controller.abort("user-cancel");
                    await thread.close();
                    await expect(iterator.next()).rejects.toThrow("事件流已断开");
                }
                expect(loadSession(storage, cwd, thread.id, resources.model)?.history.at(-1)?.content).toBe("done");
            } finally {
                await thread.close();
                await resources.close();
            }
        });
    });
}

async function* replay(
    events: readonly ThreadEvent[]
): AsyncGenerator<ThreadEvent> {
    yield* events;
}

import {createAgentRunner} from "../../src/agent/runner.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {createCompactSummaryGenerator} from "../../src/context/compactSummary.js";
import {archiveIndexPath} from "../../src/session/archiveAccess.js";

test("SDK 自动压缩保存有界交接，关闭 Resume 后经标准工具回查原始来源", async () => {
    await withTempProject(async (cwd, storage) => {
        let indexPath = "";
        const fake = createFakeLLM([
            options => {
                expect(options.kind).toBe("compact");
                expect(options.tools).toEqual([]);
                expect(JSON.stringify(options.messages)).toContain("交接覆盖限制");
                return assistantText(JSON.stringify({version: 1,
                    objective: [{text: "继续当前任务，原始细节待回查", sources: [], basis: "inferred"}],
                    constraints: [], decisions: [], files: [], verification: [], next: []}));
            },
            assistantText("本轮完成"),
            () => assistantToolCall("read_file", {path: indexPath}, "read-archive"),
            options => {
                expect(options.messages.some(message => message.role === "tool" && contentText(message.content).includes("Session archive"))).toBe(true);
                return assistantText("找到原始来源索引");
            },
        ]);
        const compactHistory = createCompactHistoryRunner({generateSummary: createCompactSummaryGenerator({callLLM: fake.callLLM})});
        const runtime = {...createFakeAgentRuntime(fake), compactHistory,
            runAgent: createAgentRunner({callLLM: fake.callLLM, compactHistory})};
        const resources = createTestRuntimeResources(cwd, {storage, agentRuntime: runtime});
        const sessionId = createSessionId();
        const first = await createSDKThread({resources, seed: {sessionId,
            history: [...createInitialHistory(cwd, resources.model), {role: "user", content: "原始目标\n" + "x".repeat(250_000)},
                {role: "assistant", content: "已检查"}], compactState: createCompactState()},
            state: {todos: [], permissionMode: "default", collaborationMode: "build", uiEvents: []}, resumed: false, onClose() {}});
        try {
            expect((await first.run("继续实现")).finalResponse).toBe("本轮完成");
            await first.close();
            const loaded = loadSession(storage, cwd, sessionId, resources.model)!;
            expect(loaded.compactState!.archives).toHaveLength(1);
            expect(JSON.stringify(loaded.history)).toContain("交接覆盖限制");
            indexPath = archiveIndexPath(storage, cwd, sessionId, loaded.compactState!.archives![0]!.id);
            const second = await createSDKThread({resources, seed: {...loaded, compactState: loaded.compactState!},
                state: {todos: [], permissionMode: "default", collaborationMode: "build", uiEvents: loaded.uiEvents}, resumed: true, onClose() {}});
            try {expect((await second.run("回查原始来源")).finalResponse).toBe("找到原始来源索引");}
            finally {await second.close();}
            expect(fake.calls).toHaveLength(4);
        } finally {await first.close(); await resources.close();}
    });
});
