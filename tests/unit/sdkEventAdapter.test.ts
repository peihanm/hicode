import {describe, expect, test} from "bun:test";
import {SDKEventAdapter} from "../../src/sdk/eventAdapter.js";
import type {ThreadEventPayload} from "../../src/sdk/protocol.js";

describe("SDK event adapter", () => {
    test("投影有界模型进度并按阶段和 Token 增量节流", () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-progress", (event) => {
            events.push(event);
        });

        adapter.handleAgentEvent({type: "model_stream_start"});
        for (const estimatedOutputTokens of [1, 64, 127, 129, 200, 260]) {
            adapter.handleAgentEvent({
                type: "model_stream_progress",
                phase: "reasoning",
                outputCharacters: estimatedOutputTokens * 4,
                estimatedOutputTokens,
            });
        }
        adapter.handleAgentEvent({
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

    test("保留完整 assistant response，不在 SDK 层静默截断", () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-full-text", (event) => {
            events.push(event);
        });
        const content = "回".repeat(12_000);

        adapter.handleAgentEvent({type: "assistant_text", content});

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
    });

    test("超限 Tool 参数只投影有界 preview", () => {
        const events: ThreadEventPayload[] = [];
        const adapter = new SDKEventAdapter("turn-large-args", (event) => {
            events.push(event);
        });
        const args = JSON.stringify({content: "x".repeat(12_000)});

        adapter.handleAgentEvent({
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
