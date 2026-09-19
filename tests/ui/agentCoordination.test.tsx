import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import {threadsFromHistory} from "../../src/ui/conversation/threadReducer.js";
import type {UIThread} from "../../src/ui/conversation/types.js";
import type {ToolCallThread} from "../../src/ui/conversation/projection.js";

afterEach(cleanup);

function agent(id: string, background = true): ToolCallThread {
    return {id, role: "tool_call", turnId: "turn", toolCallId: id, name: "agent",
        args: JSON.stringify({name: id, subagent_type: "Worker", description: `${id} implementation`, run_in_background: background}),
        status: "done", outcome: "ok", result: `Agent Task started.\nTask: private-${id}\nStatus: running\nUse task wait for required results.`};
}

test("background launch stays Started, completion is a later chronological event", () => {
    const launches = [agent("board"), agent("ui")];
    const threads: UIThread[] = [...launches,
        {id: "root-work", role: "assistant", text: "Preparing README"},
        {id: "board-done", role: "task_notification", kind: "agent", taskId: "board", status: "completed", label: "board", summary: "Finished board"}];
    const frame = render(<MessageList threads={threads}/>).lastFrame()!;
    expect(frame).toContain("Started 2 agents");
    expect(frame).toContain("board (Worker)");
    expect(frame).not.toContain("agents finished");
    expect(frame).not.toContain("private-board");
    expect(frame).not.toContain("Use task wait");
    expect(frame.indexOf("Started 2 agents")).toBeLessThan(frame.indexOf("Preparing README"));
    expect(frame.indexOf("Preparing README")).toBeLessThan(frame.indexOf("board · completed"));
    const expanded = render(<MessageList threads={threads} transcript/>).lastFrame()!;
    expect(expanded).toContain("private-board");
    expect(expanded).toContain("Use task wait");
});

test("single background launch and resume do not display a completed child report", () => {
    const call = agent("board");
    const restored = threadsFromHistory([
        {role: "assistant", content: null, tool_calls: [{id: call.toolCallId, type: "function", function: {name: "agent", arguments: call.args}}]},
        {role: "tool", tool_call_id: call.toolCallId, content: call.result!},
    ], [{version: 1, type: "tool_call", turnId: "turn", toolCallId: call.toolCallId, timestamp: new Date(0).toISOString(), outcome: "ok"}]);
    const frame = render(<MessageList threads={restored}/>).lastFrame()!;
    expect(frame).toContain("Started in background");
    expect(frame).not.toContain("Done");
    expect(render(<MessageList threads={restored} transcript/>).lastFrame()).toContain("private-board");
});

test("mixed and failed launches never claim every agent finished successfully", () => {
    const foreground = {...agent("local", false), result: "Done (1 tool call)"};
    const mixed = render(<MessageList threads={[foreground, agent("remote")]}/>).lastFrame()!;
    expect(mixed).toContain("started / completed");
    expect(mixed).toContain("Done (1 tool call)");
    const denied = {...agent("denied"), outcome: "denied" as const, result: "Workspace access denied"};
    const frame = render(<MessageList threads={[agent("board"), denied]}/>).lastFrame()!;
    expect(frame).toContain("some unsuccessful");
    expect(frame).toContain("Workspace access denied");
    expect(frame).not.toContain("Started 2 agents");
    const unknown = render(<MessageList threads={[{...agent("old"), outcome: undefined}, agent("known")]}/>).lastFrame()!;
    expect(unknown).not.toContain("some unsuccessful");
    expect(unknown).not.toContain("Started 2 agents");
});

test.each(["task", "agent_message"])("%s waits collapse only running/success rows, retaining errors and transcript", name => {
    const waiting: ToolCallThread = {id: "wait", role: "tool_call", toolCallId: "wait", name, args: '{"action":"wait"}', status: "running"};
    expect(render(<MessageList threads={[waiting]}/>).lastFrame()?.trim()).toBe("");
    const completed = {...waiting, status: "done" as const, outcome: "ok" as const, result: "Private coordination result"};
    expect(render(<MessageList threads={[completed]}/>).lastFrame()?.trim()).toBe("");
    expect(render(<MessageList threads={[completed]} transcript/>).lastFrame()).toContain("Private coordination result");
    for (const outcome of ["failed", "denied", "interrupted"] as const) {
        expect(render(<MessageList threads={[{...completed, outcome, result: "Wait was unsuccessful"}]}/>).lastFrame()).toContain("Wait was unsuccessful");
    }
});
