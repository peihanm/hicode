import {Box} from "ink";
import stringWidth from "string-width";
import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import {projectDefaultThreads} from "../../src/ui/conversation/projection.js";
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
    expect(frame).toContain("● Agent board · board implementation");
    expect(frame).toContain("● Agent ui · ui implementation");
    expect(frame.match(/Started · \/tasks/g)).toHaveLength(2);
    expect(frame).not.toContain("(Worker)");
    expect(frame).not.toContain("agents finished");
    expect(frame).not.toContain("private-board");
    expect(frame).not.toContain("Use task wait");
    expect(frame.indexOf("Agent board")).toBeLessThan(frame.indexOf("Preparing README"));
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
    expect(frame).toContain("Started · /tasks");
    expect(frame).not.toContain("Done");
    expect(render(<MessageList threads={restored} transcript/>).lastFrame()).toContain("private-board");
});

test("mixed and failed launches never claim every agent finished successfully", () => {
    const foreground = {...agent("local", false), result: "Done (1 tool call)"};
    const mixed = render(<MessageList threads={[foreground, agent("remote")]}/>).lastFrame()!;
    expect(mixed).toContain("Agent local");
    expect(mixed).toContain("Agent remote");
    expect(mixed).toContain("Done (1 tool call)");
    const denied = {...agent("denied"), outcome: "denied" as const, result: "Workspace access denied"};
    const frame = render(<MessageList threads={[agent("board"), denied]}/>).lastFrame()!;
    expect(frame).toContain("Agent denied");
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

test("incremental appends and full replay keep identical individual Agent rows", () => {
    const calls = [agent("board"), agent("ui")];
    expect(projectDefaultThreads(calls)).toEqual(calls.flatMap(call => projectDefaultThreads([call])));
    const whole = render(<MessageList threads={calls}/>).lastFrame()!.trim();
    const appended = calls.map(call => render(<MessageList threads={[call]}/>).lastFrame()!.trim()).join("\n\n");
    expect(whole).toBe(appended);
    expect(whole).not.toMatch(/├─|└─|Started 2 agents/);
});

test("creation and followup share compact rows; receipts do not depend on result wording", () => {
    const created = agent("board");
    created.args = JSON.stringify({name: "board", description: "board：状态逻辑与单元测试", run_in_background: true});
    const followup: ToolCallThread = {id: "followup", role: "tool_call", toolCallId: "followup", name: "agent_followup",
        args: '{"target":"private-id","message":"long task instructions"}', status: "done", outcome: "ok", result: "Raw receipt wording may change",
        uiData: {type: "agent_receipt", receipt: {name: "board", description: "board：状态逻辑与单元测试", delivery: "continued"}}};
    const frame = render(<MessageList threads={[created, followup]}/>).lastFrame()!;
    expect(frame.match(/● Agent board · 状态逻辑与单元测试/g)).toHaveLength(2);
    expect(frame).toContain("Started · /tasks");
    expect(frame).toContain("Continued · /tasks");
    expect(frame).not.toContain("Worker");
    expect(frame).not.toContain("private-id");
    expect(frame).not.toContain("Raw receipt");
    expect(render(<MessageList threads={[followup]} transcript/>).lastFrame()).toContain("Raw receipt wording may change");
    const queued = {...followup, uiData: {type: "agent_receipt" as const, receipt: {name: "board", description: "work", delivery: "queued" as const}}};
    expect(render(<MessageList threads={[queued]}/>).lastFrame()).toContain("Queued · /tasks");
    const denied = {...followup, outcome: "denied" as const, result: "Directory access denied"};
    const failedFrame = render(<MessageList threads={[denied]}/>).lastFrame()!;
    expect(failedFrame).toContain("Directory access denied");
    expect(failedFrame).not.toContain("Continued · /tasks");
});

test("completion notifications remain interleaved with Root commentary", () => {
    const threads: UIThread[] = [agent("board"), agent("ui"),
        {id: "ui-done", role: "task_notification", kind: "agent", taskId: "ui", status: "completed", label: "ui", summary: "long report"},
        {id: "check-ui", role: "assistant", text: "Checking the UI interface"},
        {id: "board-done", role: "task_notification", kind: "agent", taskId: "board", status: "completed", label: "board", summary: "long report"}];
    for (const transcript of [false, true]) {
        const frame = render(<MessageList threads={threads} transcript={transcript}/>).lastFrame()!;
        expect(frame.indexOf("✓ ui · completed")).toBeLessThan(frame.indexOf("Checking the UI interface"));
        expect(frame.indexOf("Checking the UI interface")).toBeLessThan(frame.indexOf("✓ board · completed"));
        expect(frame).not.toContain("long report");
    }
});


test("Agent titles remain a single compact row in narrow terminals", () => {
    const call = agent("board");
    call.args = JSON.stringify({name: "board", subagent_type: "Worker", description: "board：状态逻辑、持久化、筛选与测试".repeat(10), run_in_background: true});
    for (const width of [30, 60, 100]) {
        const frame = render(<Box width={width}><MessageList threads={[call]} terminalWidth={width}/></Box>).lastFrame()!.trimEnd();
        const lines = frame.split("\n").filter(line => line.trim());
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("Agent board");
        expect(lines[1]).toContain("Started · /tasks");
        expect(lines.every(line => stringWidth(line) <= width)).toBe(true);
    }
});
