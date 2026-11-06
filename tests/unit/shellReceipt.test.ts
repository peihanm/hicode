import {expect, test} from "bun:test";
import {shellResultReceipt} from "../../src/tools/bash/receipt.js";
import {SessionUIEventCollector} from "../../src/session/uiEvents.js";
import {decodeSessionContentBlock} from "../../src/session/store/codec.js";
import {reduceThreads, threadsFromHistory} from "../../src/ui/conversation/threadReducer.js";
import type {ShellTermination} from "../../src/tools/bash/process.js";
import type {AgentEvent} from "../../src/agent/types.js";

test("Shell receipts survive failed results, event persistence and resume without parsing stdout", () => {
    const cases: ShellTermination[] = [
        {kind: "exit", code: 1, signal: null}, {kind: "exit", code: 143, signal: "SIGTERM"},
        {kind: "timeout", timeoutMs: 10}, {kind: "aborted", reason: "user-cancel"},
        {kind: "spawn_error", error: new Error("could not start")}, {kind: "output_limit", maxBuffer: 100},
    ];
    for (const termination of cases) {
        const receipt = shellResultReceipt(termination);
        expect(receipt.termination).toBe(termination.kind === "exit" && termination.signal ? "signal" : termination.kind);
        const collector = new SessionUIEventCollector();
        const start: AgentEvent = {type: "tool_call_start", turnId: "turn", toolCallId: "bash", name: "bash", args: "{}"};
        const end: AgentEvent = {type: "tool_call_end", turnId: "turn", toolCallId: "bash", outcome: "failed",
            result: "EXIT=0", uiData: {type: "shell_result", receipt}};
        collector.handleEvent(start); collector.handleEvent(end);
        const events = collector.getEvents().map(event => {
            const decoded = decodeSessionContentBlock(JSON.parse(JSON.stringify({kind: "ui", value: event})));
            if (decoded.kind !== "ui") throw new Error("Expected UI block");
            return decoded.value;
        });
        const restored = threadsFromHistory([
            {role: "assistant", content: null, tool_calls: [{id: "bash", type: "function", function: {name: "bash", arguments: "{}"}}]},
            {role: "tool", tool_call_id: "bash", content: "EXIT=0"},
        ], events);
        expect(restored[0]).toMatchObject({outcome: "failed", uiData: end.uiData, result: "EXIT=0"});
        const failure: AgentEvent = {type: "tool_result_delivery", toolCallId: "bash", status: "failed", outcome: "failed", result: "save failed"};
        collector.handleEvent(failure);
        expect(collector.getEvents()[0]).toMatchObject({shellResult: {...receipt, outputFailed: true}});
        const live = reduceThreads(reduceThreads([], start), end);
        expect(reduceThreads(live, failure)[0]).toMatchObject({uiData: {type: "shell_result", receipt: {...receipt, outputFailed: true}}});
    }
});

test("execution deadline cancellation is a timeout warning", () => {
    expect(shellResultReceipt({kind: "aborted", reason: "timeout"})).toEqual({termination: "timeout", outputFailed: false});
});
