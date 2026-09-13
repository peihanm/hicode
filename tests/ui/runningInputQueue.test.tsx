import {contentText} from "../../src/images/content.js";
import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import type { AgentRunner } from "../../src/agent/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {loadSession, type LoadedSession} from "../../src/session/index.js";
import {QueuedInputPreview} from "../../src/ui/input/QueuedInputPreview.js";

afterEach(() => cleanup());

describe("running input queue UI", () => {
    test("Agent 运行时输入框保持可用，普通输入进入 next", async () => {
        await withTempProject(async (cwd) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let queued: readonly string[] = [];
            const runAgentImpl = (async (
                _input,
                _history,
                _onEvent,
                _ctx,
                inputChannel
            ) => {
                await gate;
                queued = inputChannel.drainSafeBoundary()
                    .map((message) => contentText(message.content));
                return {reply: "ok", reason: "completed", iterations: 1};
            }) as AgentRunner;
            const resources = createTestRuntimeResources(cwd);
            const instance = render(
                <AppForTest resources={resources} runAgentImpl={runAgentImpl}/>
            );

            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("原始任务");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));
            instance.stdin.write("补充要求");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));

            expect(instance.lastFrame()).toContain("❯ 补充要求");
            expect(instance.lastFrame()).toContain("↑ Edit queued message");
            release();
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(queued).toEqual(["补充要求"]);
            await resources.close();
        });
    });

    test("向上键把排队输入放回草稿，不再在安全边界消费", async () => {
        await withTempProject(async (cwd) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let injected: readonly string[] = [];
            const runAgentImpl = (async (
                _input,
                _history,
                _onEvent,
                _ctx,
                inputChannel
            ) => {
                await gate;
                injected = inputChannel.drainSafeBoundary()
                    .map((message) => contentText(message.content));
                return {reply: "ok", reason: "completed", iterations: 1};
            }) as AgentRunner;
            const resources = createTestRuntimeResources(cwd);
            const instance = render(
                <AppForTest resources={resources} runAgentImpl={runAgentImpl}/>
            );

            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("原始任务\r");
            await new Promise((resolve) => setTimeout(resolve, 30));
            instance.stdin.write("排队补充\r");
            await new Promise((resolve) => setTimeout(resolve, 30));
            instance.stdin.write("当前草稿");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\u001B[A");
            await new Promise((resolve) => setTimeout(resolve, 20));

            const frame = instance.lastFrame() ?? "";
            expect(frame).toContain("排队补充");
            expect(frame).toContain("当前草稿");
            expect(frame).not.toContain("↑ Edit queued message");

            release();
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(injected).toEqual([]);
            await resources.close();
        });
    });

    test("恢复 Session 时用户排队输入变成可编辑草稿", async () => {
        await withTempProject(async (cwd, storage) => {
            const resources = createTestRuntimeResources(cwd);
            const inputs: string[] = [];
            const initialSession: LoadedSession = {
                sessionId: "resumed-session",
                cwd,
                model: resources.model,
                history: [
                    {role: "system", content: "system"},
                    {role: "user", origin: "user" as const, content: "旧任务"},
                    {role: "assistant", content: "旧任务已完成"},
                ],
                todos: [],
                permissionMode: "ask",
        collaborationMode: "build",
                uiEvents: [],
                taskNotificationReceipts: [],
                queuedInputs: [
                    {
                        id: "queued-user",
                        type: "user_input",
                        priority: "later",
                        content: "恢复后的草稿",
                        createdAt: "2026-07-26T00:00:00.000Z",
                    },
                    {
                        id: "a".repeat(64),
                        type: "task_notification",
                        priority: "next",
                        taskId: "task-1",
                        content: "后台任务完成",
                        createdAt: "2026-07-26T00:00:01.000Z",
                    },
                ],
            };
            const instance = render(
                <AppForTest
                    resources={resources}
                    initialSession={initialSession}
                    runAgentImpl={(async (input) => {
                        inputs.push(contentText(input));
                        return {reply: "ok", reason: "completed", iterations: 1};
                    }) as AgentRunner}
                />
            );

            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(instance.lastFrame()).toContain("恢复后的草稿");
            expect(inputs).toEqual([]);
            expect(
                loadSession(storage, cwd, initialSession.sessionId, resources.model)
                    ?.queuedInputs
            ).toEqual([initialSession.queuedInputs[1]]);

            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(inputs).toEqual(["恢复后的草稿"]);
            await resources.close();
        });
    });

    test("队列预览最多展示三条，每条最多两行", () => {
        const instance = render(
            <QueuedInputPreview messages={[
                {
                    id: "1",
                    type: "user_input",
                    priority: "next",
                    content: "第一行\n第二行\n第三行不应展示",
                    createdAt: "2026-07-26T00:00:00.000Z",
                },
                {
                    id: "2",
                    type: "user_input",
                    priority: "next",
                    content: "第二条消息",
                    createdAt: "2026-07-26T00:00:01.000Z",
                },
                {
                    id: "3",
                    type: "user_input",
                    priority: "next",
                    content: "第三条消息",
                    createdAt: "2026-07-26T00:00:02.000Z",
                },
                {
                    id: "4",
                    type: "user_input",
                    priority: "next",
                    content: "第四条不应展示",
                    createdAt: "2026-07-26T00:00:03.000Z",
                },
            ]}/>
        );

        const frame = instance.lastFrame() ?? "";
        expect(frame).toContain("第一行");
        expect(frame).toContain("第二行…");
        expect(frame).not.toContain("第三行不应展示");
        expect(frame).not.toContain("第四条不应展示");
        expect(frame).toContain("plus 1 more");
    });
});

test("queued child messages are visible but not offered for user editing", () => {
    const view = render(<QueuedInputPreview messages={[{id: "msg", type: "agent_message", priority: "next", content: "Need interface decision", createdAt: new Date().toISOString(),
        route: {sender: "00000000-0000-0000-0000-000000000000", recipient: "parent", runCount: 1, intent: "message"}}]}/>);
    expect(view.lastFrame()).toContain("Agent: Need interface decision");
    expect(view.lastFrame()).not.toContain("↑ Edit queued message");
    view.unmount();
});
