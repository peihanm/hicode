import {describe, expect, test} from "bun:test";
import {collectTurnResult} from "../../src/sdk/resultCollector.js";
import type {ThreadEvent, ThreadEventPayload, ThreadItem} from "../../src/sdk/protocol.js";

const start: ThreadEventPayload = {type: "turn.started", turnId: "turn", inputSummary: "hello"};
const end: ThreadEventPayload = {type: "turn.completed", turnId: "turn", usage: null, stopReason: "completed", iterations: 1, durationMs: 10};
const message: ThreadItem = {id: "answer", type: "agent_message", phase: "final", text: "done", status: "in_progress"};
const progress: Exclude<ThreadEventPayload, {type: "thread.started"}>[] = [
    {type: "turn.draft", turnId: "turn", responseId: "draft", text: "draft", truncated: false},
    {type: "turn.draft_end", turnId: "turn", responseId: "draft", disposition: "discarded"},
    {type: "turn.progress", turnId: "turn", phase: "content", outputCharacters: 5, estimatedOutputTokens: 2},
    {type: "turn.task_wait", turnId: "turn", taskIds: ["task"]},
    {type: "turn.approval_review", turnId: "turn", review: {type: "approval_review", phase: "start", requestId: "approval", turnId: "turn", toolCallId: "call", source: "user"}},
    {type: "turn.settled", turnId: "turn", input: {session_id: "thread", hook_event_name: "TurnEnd", status: "completed", reason: "completed", persistence_status: "saved"}},
];
function events(payloads: ThreadEventPayload[]): ThreadEvent[] {
    return payloads.map((payload, index) => ({...payload, protocolVersion: 1, sequence: 41 + index, threadId: "thread", emittedAt: "2026-11-06T00:00:00.000Z"}));
}
async function* stream(values: ThreadEvent[]) { yield* values; }
const collect = (payloads: ThreadEventPayload[]) => collectTurnResult(stream(events(payloads)));
const itemEvent = (type: "item.started" | "item.updated" | "item.completed", item: ThreadItem = message): Extract<ThreadEventPayload, {type: "item.started" | "item.updated" | "item.completed"}> => ({type, turnId: "turn", item});

describe("SDK result collector", () => {
    test.each([false, true])("collects complete lifecycle, optional thread.started=%s, sequence may start above one", async first => {
        const denied: ThreadItem = {id: "tool", type: "tool_call", status: "in_progress", toolCallId: "call", name: "bash", category: "builtin", arguments: {}};
        const result = await collect([
            ...(first ? [{type: "thread.started"} as const] : []), start, ...progress,
            itemEvent("item.started", denied), itemEvent("item.completed", {...denied, status: "denied"}),
            itemEvent("item.started"), itemEvent("item.updated", {...message, text: "updated"}),
            itemEvent("item.completed", {...message, status: "completed"}),
            itemEvent("item.started", {...message, id: "comment", phase: "commentary"}),
            itemEvent("item.completed", {...message, id: "comment", phase: "commentary", text: "later commentary", status: "completed"}), end,
        ]);
        expect(result.finalResponse).toBe("done");
        expect(result.items.map(item => item.status)).toEqual(["denied", "completed", "completed"]);
        expect(result.threadId).toBe("thread");
    });

    test("rejects mixed threads and releases the source iterator", async () => {
        const values = events([start, end]);
        values[1] = {...values[1]!, threadId: "foreign"};
        let closed = false;
        async function* source() { try { yield* values; } finally { closed = true; } }
        await expect(collectTurnResult(source())).rejects.toMatchObject({code: "event_thread_mismatch"});
        expect(closed).toBe(true);
    });

    test("checks Turn identity on every progress and item event, including task/review/settled", async () => {
        for (const payload of [...progress, itemEvent("item.started"), itemEvent("item.updated"), itemEvent("item.completed"), end,
            {type: "turn.failed", turnId: "turn", error: {code: "failed", message: "failed"}} as const]) {
            await expect(collect([start, {...payload, turnId: "foreign"}, end])).rejects.toMatchObject({code: "event_turn_mismatch"});
        }
    });

    test("rejects reused item IDs and changed item types", async () => {
        await expect(collect([start, itemEvent("item.started"), itemEvent("item.completed", {...message, status: "completed"}), itemEvent("item.started"), end]))
            .rejects.toMatchObject({code: "duplicate_item_start"});
        await expect(collect([start, itemEvent("item.started"), itemEvent("item.completed", {id: message.id, type: "todo_list", todos: [], status: "completed"}), end]))
            .rejects.toMatchObject({code: "item_type_mismatch"});
    });

    test("rejects incomplete or invalid lifecycles", async () => {
        const cases: [ThreadEventPayload[], string][] = [
            [[start, itemEvent("item.updated"), end], "unknown_item_update"],
            [[start, itemEvent("item.completed"), end], "unknown_item_completion"],
            [[start, itemEvent("item.started"), end], "unclosed_items"],
            [[start, itemEvent("item.started"), itemEvent("item.completed"), end], "invalid_item_completion"],
            [[start, start, end], "duplicate_turn_start"],
            [[start, end, ...progress], "event_after_terminal"],
            [[start, {type: "thread.started"}, end], "invalid_thread_start"],
            [[start], "missing_turn_terminal"],
            [[end], "event_turn_mismatch"],
        ];
        for (const [payloads, code] of cases) await expect(collect(payloads)).rejects.toMatchObject({code});
    });

    test("validates sequence and protocol, preserves terminal failure", async () => {
        for (const sequence of [0, 41, 43, 42.5, Number.NaN]) {
            const values = events([start, end]);
            values[1] = {...values[1]!, sequence};
            await expect(collectTurnResult(stream(values))).rejects.toMatchObject({code: "invalid_event_sequence"});
        }
        const values = events([start, end]);
        // @ts-expect-error Simulate an unsupported external event protocol.
        values[0] = {...values[0]!, protocolVersion: 2};
        await expect(collectTurnResult(stream(values))).rejects.toMatchObject({code: "invalid_protocol_version"});
        await expect(collect([start, {type: "turn.failed", turnId: "turn", error: {code: "provider_failed", message: "unavailable"}}]))
            .rejects.toMatchObject({code: "provider_failed", message: "unavailable"});
    });
});
