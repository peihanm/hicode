import {expect, test} from "bun:test";
import {executeToolCallBatch} from "../../src/agent/toolBatch.js";
import {processToolOutput} from "../../src/toolResults/budget.js";
import {createSessionPersistence} from "../../src/session/storage.js";
import {SessionUIEventCollector} from "../../src/session/uiEventCollector.js";
import {SDKEventAdapter} from "../../src/sdk/eventAdapter.js";
import {reduceThreads} from "../../src/ui/conversation/threadReducer.js";
import type {UIThread} from "../../src/ui/conversation/types.js";
import type {ThreadEventPayload} from "../../src/sdk/protocol.js";
import type {Message, ToolCall} from "../../src/llm/types.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

test.each([[0, true], [0, false], [1_000_000, true]] as const)("batch delivery updates all consumers without mutating frozen snapshots (quota=%s, parallel=%s)", async (quota, parallel) => {
    await withTempProject(async (cwd, storage) => {
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "batch", {maxSessionBytes: quota})});
        const writer = createSessionPersistence(storage, cwd, ctx.sessionId);
        const calls: ToolCall[] = Array.from({length: 6}, (_, i) => ({id: `c${i}`, type: "function", function: {name: "fixture", arguments: "{}"}}));
        const history: Message[] = [{role: "user", origin: "user", content: "fixture"}, {role: "assistant", content: null, tool_calls: calls}];
        const events: AgentEvent[] = [], sdkEvents: ThreadEventPayload[] = [];
        const collector = new SessionUIEventCollector();
        const sdk = new SDKEventAdapter("turn", event => {sdkEvents.push(event);});
        let threads: UIThread[] = [], frozen: Message[] = [];
        let hookOutcomes: string[] = [];
        const snapshot = () => ({cwd, sessionId: ctx.sessionId, model: ctx.model, history, todos: [],
            permissionMode: "ask" as const,  uiEvents: [...collector.getEvents()]});
        ctx.runHook = async input => {
            if (input.hook_event_name === "PostToolBatch") hookOutcomes = input.tools.map(tool => tool.outcome);
            return {blocked: false, additionalContexts: [], executions: []};
        };
        const result = await executeToolCallBatch({ctx, history, toolCalls: calls, turnId: "turn", isToolConcurrencySafe: () => parallel,
            executeTool: async (_name, _args, _ctx, id) => processToolOutput({store: ctx.toolResultStore, output: "x".repeat(40_000), toolName: "fixture", toolCallId: id!}),
            onEvent: async event => {
                events.push(event); collector.handleEvent(event); threads = reduceThreads(threads, event); await sdk.handleAgentEvent(event);
                if (event.type === "tool_call_end" && event.toolCallId === "c5") {await writer.save(snapshot()); frozen = history.slice(2);}
            }});
        await writer.save(snapshot());
        await sdk.finish("completed");
        expect(result.status).toBe("completed");
        expect(frozen.every(message => Object.isFrozen(message) && message.content === "x".repeat(40_000))).toBe(true);
        const updates = events.filter(event => event.type === "tool_result_delivery");
        expect(updates.length).toBeGreaterThan(0);
        expect(events.filter(event => event.type === "tool_call_end")).toHaveLength(6);
        expect(hookOutcomes).toEqual(result.outcomes.map(outcome => outcome.outcome));
        for (const update of updates) {
            if (update.type !== "tool_result_delivery") throw new Error("Invalid fixture");
            expect(update.status).toBe(quota ? "saved" : "failed");
            const outcome = result.outcomes.find(item => item.toolCallId === update.toolCallId)!;
            expect(outcome.outcome).toBe(quota ? "ok" : "output_failed");
            if (!quota) {
                expect(outcome.persisted).toBeUndefined();
                expect(collector.getEvents()).toContainEqual(expect.objectContaining({type: "tool_call", toolCallId: update.toolCallId, outcome: "output_failed"}));
                expect(threads).toContainEqual(expect.objectContaining({role: "tool_call", toolCallId: update.toolCallId, outcome: "output_failed"}));
                expect(sdkEvents).toContainEqual(expect.objectContaining({type: "item.completed", item: expect.objectContaining({toolCallId: update.toolCallId, status: "failed", outcome: "output_failed"})}));
            }
        }
    });
});
