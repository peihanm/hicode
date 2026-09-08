import {describe, expect, test} from "bun:test";
import {SDKEventAdapter} from "../../src/sdk/eventAdapter.js";
import type {ThreadEventPayload} from "../../src/sdk/protocol.js";

describe("SDK event adapter", async () => {
    test("连续恢复进度保留原因和请求次数，不被同阶段节流吞掉", async () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-retry", event => {events.push(event);});
        for (const attempt of [2, 3]) {
            await adapter.handleAgentEvent({type: "model_stream_progress", phase: "retrying",
                outputCharacters: 0, estimatedOutputTokens: 0,
                retry: {reason: "http", attempt, maxAttempts: 3}});
        }
        expect(events).toHaveLength(2);
        expect(events).toEqual([2, 3].map(attempt => expect.objectContaining({
            type: "turn.progress", retry: {reason: "http", attempt, maxAttempts: 3},
        })));
    });
    test.each(["completed", "interrupted"] as const)("子 Agent %s 投影运行状态并原样保留审查结论", async reason => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-review", event => {events.push(event);});
        await adapter.handleAgentEvent({type: "subagent_start", agentId: "reviewer", agentType: "project-reviewer",
            parentToolCallId: "review-call", description: "检查并发写入"});
        await adapter.handleAgentEvent({type: "subagent_end", agentId: "reviewer", agentType: "project-reviewer",
            reason, iterations: 2, toolUseCount: 1, durationMs: 10, report: "发现并发写入风险。\nVERDICT: FAIL"});
        const event = events.find(event => event.type === "item.completed");
        expect(event?.type).toBe("item.completed");
        if (event?.type !== "item.completed") throw new Error("缺少子 Agent 完成事件");
        expect(event.item).toMatchObject({type: "subagent", status: reason, reason,
            reportPreview: "发现并发写入风险。\nVERDICT: FAIL"});
        expect(event.item).not.toHaveProperty("verificationVerdict");
    });

    test("草稿快照及撤销独立于正式 Item，最终正文关联同一响应", async () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn", event => {events.push(event);});
        await adapter.handleAgentEvent({type: "assistant_draft", responseId: "r", text: "draft", truncated: false});
        expect(events[0]?.type).toBe("turn.draft");
        await adapter.handleAgentEvent({type: "assistant_draft_end", responseId: "r", disposition: "committed"});
        await adapter.handleAgentEvent({type: "assistant_text", content: "final", responseId: "r", phase: "final"});
        expect(events.filter(event => event.type === "item.completed")).toEqual([expect.objectContaining({item: expect.objectContaining({text: "final", responseId: "r"})})]);
    });
    test("投影有界模型进度并按阶段和 Token 增量节流", async () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-progress", (event) => {
            events.push(event);
        });

        await adapter.handleAgentEvent({type: "model_stream_start"});
        for (const estimatedOutputTokens of [1, 64, 127, 129, 200, 260]) {
            await adapter.handleAgentEvent({
                type: "model_stream_progress",
                phase: "reasoning",
                outputCharacters: estimatedOutputTokens * 4,
                estimatedOutputTokens,
            });
        }
        await adapter.handleAgentEvent({
            type: "model_stream_progress",
            phase: "tool_input",
            outputCharacters: 1_100,
            estimatedOutputTokens: 275,
            toolName: "write_file",
        });

        expect(events.filter((event) => event.type === "turn.progress"))
            .toEqual([
                expect.objectContaining({
                    type: "turn.progress",
                    phase: "model_waiting",
                    estimatedOutputTokens: 0,
                }),
                expect.objectContaining({
                    type: "turn.progress",
                    phase: "reasoning",
                    estimatedOutputTokens: 1,
                }),
                expect.objectContaining({
                    type: "turn.progress",
                    phase: "reasoning",
                    estimatedOutputTokens: 129,
                }),
                expect.objectContaining({
                    type: "turn.progress",
                    phase: "reasoning",
                    estimatedOutputTokens: 260,
                }),
                expect.objectContaining({
                    type: "turn.progress",
                    phase: "tool_input",
                    estimatedOutputTokens: 275,
                    toolName: "write_file",
                }),
            ]);
    });

    test("保留完整 assistant response，不在 SDK 层静默截断", async () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-full-text", (event) => {
            events.push(event);
        });
        const content = "回".repeat(12_000);

        await adapter.handleAgentEvent({
            type: "assistant_text",
            content,
            phase: "commentary",
        });

        const completed = events.find(
            (event) =>
                event.type === "item.completed" &&
                event.item.type === "agent_message"
        );
        expect(completed?.type).toBe("item.completed");
        if (
            completed?.type !== "item.completed" ||
            completed.item.type !== "agent_message"
        ) {
            throw new Error("缺少 agent_message completed event");
        }
        expect(completed.item.text).toBe(content);
        expect(completed.item.phase).toBe("commentary");
    });

    test("超限 Tool 参数只投影有界 preview", async () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-large-args", (event) => {
            events.push(event);
        });
        const args = JSON.stringify({content: "x".repeat(12_000)});

        await adapter.handleAgentEvent({
            type: "tool_call_start",
            turnId: "internal-turn",
            toolCallId: "large-call",
            name: "write_file",
            args,
        });

        const started = events.at(0);
        expect(started?.type).toBe("item.started");
        if (
            started?.type !== "item.started" ||
            started.item.type !== "tool_call"
        ) {
            throw new Error("缺少 tool_call started event");
        }
        expect(started.item.arguments).toEqual({
            raw: `${args.slice(0, 9_999)}…`,
            truncated: true,
        });
    });
});
