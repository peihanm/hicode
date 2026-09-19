import {notificationFor} from "../../src/tasks/notifications.js";
import {expect, test} from "bun:test";
import {createAgentReceipt} from "../../src/tools/agent/receipt.js";
import {SessionUIEventCollector} from "../../src/session/uiEventCollector.js";
import {decodeSessionContentBlock} from "../../src/session/codec.js";
import {threadsFromHistory} from "../../src/ui/conversation/threadReducer.js";
import {toolFileChanges} from "../../src/fileChanges/types.js";

test("Agent receipts survive the normal event codec and history restoration without becoming file changes", () => {
    const collector = new SessionUIEventCollector();
    const receipt = createAgentReceipt("board", "state logic", "continued");
    const uiData = {type: "agent_receipt" as const, receipt};
    collector.handleEvent({type: "tool_call_start", turnId: "turn", toolCallId: "followup", name: "agent_followup", args: '{"target":"id","message":"next"}'});
    collector.handleEvent({type: "tool_call_end", turnId: "turn", toolCallId: "followup", outcome: "ok", result: "opaque receipt", uiData});
    expect(toolFileChanges(uiData, "ok")).toEqual([]);
    const events = collector.getEvents().map(event => {
        const decoded = decodeSessionContentBlock(JSON.parse(JSON.stringify({kind: "ui", value: event})));
        if (decoded.kind !== "ui") throw new Error("Expected UI block");
        return decoded.value;
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({type: "tool_call", agentReceipt: receipt});
    const threads = threadsFromHistory([
        {role: "assistant", content: null, tool_calls: [{id: "followup", type: "function", function: {name: "agent_followup", arguments: '{"target":"id","message":"next"}'}}]},
        {role: "tool", tool_call_id: "followup", content: "opaque receipt"},
    ], events);
    expect(threads[0]).toMatchObject({name: "agent_followup", uiData, result: "opaque receipt"});
    for (const bad of [{...receipt, delivery: "finished"}, {...receipt, name: "x".repeat(257)}, {...receipt, description: "x".repeat(4097)}, {...receipt, extra: true}]) {
        expect(() => decodeSessionContentBlock({kind: "ui", value: {...events[0], agentReceipt: bad}})).toThrow("Invalid Session content block");
    }
});

test("oversized Agent labels are bounded before persistence and failed results never gain success receipts", () => {
    const receipt = createAgentReceipt("x".repeat(500), "y".repeat(5000), "started");
    expect(receipt.name).toHaveLength(256);
    expect(receipt.description).toHaveLength(4096);
    const collector = new SessionUIEventCollector();
    collector.handleEvent({type: "tool_call_start", turnId: "turn", toolCallId: "launch", name: "agent", args: "{}"});
    collector.handleEvent({type: "tool_call_end", turnId: "turn", toolCallId: "launch", outcome: "denied", result: "denied", uiData: {type: "agent_receipt", receipt}});
    const event = collector.getEvents()[0];
    expect(event).toMatchObject({type: "tool_call", outcome: "denied"});
    expect(event).not.toHaveProperty("agentReceipt");
});


test("compact notification labels preserve the model's descriptive completion message", () => {
    const notification = notificationFor({id: "board-id", kind: "agent", cwd: "/project",
        owner: {sessionId: "session", toolCallId: "spawn"}, agentType: "Worker", agentName: "board", description: "State logic and tests",
        status: "completed", startedAt: "2026-09-19T00:00:00.000Z", completedAt: "2026-09-19T00:00:01.000Z",
        progress: {runCount: 1, runStartedAt: "2026-09-19T00:00:00.000Z", previousDurationMs: 0, todosUpdated: false, iterations: 1, toolUseCount: 0, pendingMessages: 0}});
    expect(notification.label).toBe("board");
    expect(notification.message).toContain("board (Worker) · State logic and tests");
});
