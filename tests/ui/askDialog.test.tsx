import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import stringWidth from "string-width";
import {AskDialog} from "../../src/ui/dialogs/AskDialog.js";
import {TerminalInputProvider} from "../../src/ui/input/terminalInput.js";
import {TerminalSizeProvider} from "../../src/ui/terminalSize.js";
import type {PermissionDecision} from "../../src/permissions/index.js";

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 25));

test("question input has no choice numbering or confirmation step; Enter submits once", async () => {
    const decisions: PermissionDecision[] = [];
    const req = {id: 1, question: "昵称？", toolName: "ask_user", input: {questions: [{question: "昵称？"}]},
        resolve: (value: PermissionDecision) => decisions.push(value)};
    const view = render(<AskDialog req={req} onDone={() => {}}/>);
    await flush();
    expect(view.lastFrame()).toContain("Type your answer");
    expect(view.lastFrame()).not.toContain("1.");
    expect(view.lastFrame()).not.toContain("Confirm input");
    view.stdin.write("小明🙂"); await flush();
    view.stdin.write("\r"); await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"昵称？": "小明🙂"}}]);
});

test("multiple questions advance on Enter and submit only after the last answer", async () => {
    const decisions: PermissionDecision[] = [];
    const view = render(<AskDialog req={{id: 2, question: "方案？", toolName: "ask_user",
        input: {questions: [{question: "方案？", options: [{label: "A"}, {label: "B"}]}, {question: "环境？"}]},
        resolve: d => decisions.push(d)}} onDone={() => {}}/>);
    await flush(); expect(view.lastFrame()).toContain("Question 1 of 2");
    view.stdin.write("\r"); await flush();
    expect(view.lastFrame()).toContain("Question 2 of 2");
    expect(decisions).toEqual([]);
    view.stdin.write("local"); await flush();
    view.stdin.write("\r"); await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"方案？": "A", "环境？": "local"}}]);
});

test("custom text submits directly; multi-select supports both Enter and Space with explicit submission", async () => {
    const decisions: PermissionDecision[] = [];
    const view = render(<AskDialog req={{id: 3, question: "平台？", toolName: "ask_user",
        input: {questions: [{question: "平台？", multi_select: true, options: [{label: "Linux"}, {label: "macOS"}]}]},
        resolve: d => decisions.push(d)}} onDone={() => {}}/>);
    await flush();
    view.stdin.write("\u001b[A"); await flush(); // Wrap to Submit selections, with no selection.
    view.stdin.write("\r"); await flush();
    expect(decisions).toHaveLength(0);
    view.stdin.write("\u001b[B"); await flush();
    view.stdin.write("\r"); await flush();
    expect(view.lastFrame()).toContain("[x] Linux");
    expect(decisions).toHaveLength(0);
    view.stdin.write(" "); await flush();
    expect(view.lastFrame()).toContain("[ ] Linux");
    view.stdin.write("\r"); await flush();
    view.stdin.write("\u001b[B"); await flush();
    view.stdin.write("\r"); await flush();
    expect(view.lastFrame()).toContain("[x] Linux");
    expect(view.lastFrame()).toContain("[x] macOS");
    expect(decisions).toHaveLength(0);
    view.stdin.write("\u001b[B"); await flush();
    view.stdin.write("\u001b[B"); await flush();
    view.stdin.write("\r"); await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"平台？": ["Linux", "macOS"]}}]);
    const custom = render(<AskDialog req={{id: 4, question: "方案？", toolName: "ask_user",
        input: {questions: [{question: "方案？", options: [{label: "A"}]}]}, resolve: d => decisions.push(d)}} onDone={() => {}}/>);
    await flush(); custom.stdin.write("\u001b[B"); await flush(); custom.stdin.write("\r"); await flush();
    custom.stdin.write("自己的方案"); await flush(); custom.stdin.write("\r"); await flush();
    expect(decisions.at(-1)).toEqual({behavior: "allow", answers: {"方案？": "自己的方案"}});
});

test("hidden async editor ignores input and preserves its draft through collapse, resize and focus return", async () => {
    const decisions: PermissionDecision[] = [];
    let backs = 0;
    const req = {id: 5, question: "昵称？", toolName: "ask_user", input: {questions: [{question: "昵称？"}]},
        resolve: (d: PermissionDecision) => decisions.push(d)};
    const panel = (active: boolean) => <AskDialog req={req} active={active} onBack={() => backs++} onDone={() => {}}/>;
    const view = render(panel(true));
    await flush(); view.stdin.write("草稿🙂"); await flush();
    view.stdin.write("\u001b[1;2C"); await flush(); expect(backs).toBe(1);
    view.rerender(panel(false)); await flush();
    view.stdin.write("ignored"); view.stdin.write("\r"); await flush();
    expect(decisions).toEqual([]);
    view.rerender(panel(true)); await flush();
    expect(view.lastFrame()).toContain("草稿🙂");
    expect(view.lastFrame()).not.toContain("ignored");
    view.stdin.write("\r"); await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"昵称？": "草稿🙂"}}]);
});

test("Chinese and emoji reflow narrow-wide-narrow; bracketed paste cannot activate question shortcuts", async () => {
    const decisions: PermissionDecision[] = [];
    let backs = 0;
    const req = {id: 6, question: "中文问题", toolName: "ask_user", input: {questions: [{question: "长中文问题🙂请写下你想使用的测试昵称，然后按回车即可。"}]},
        resolve: (d: PermissionDecision) => decisions.push(d)};
    const view = render(<TerminalInputProvider><TerminalSizeProvider><AskDialog req={req} onBack={() => backs++} onDone={() => {}}/></TerminalSizeProvider></TerminalInputProvider>);
    let columns = 30;
    Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
    for (const width of [30, 90, 30]) {
        columns = width; view.stdout.emit("resize"); await new Promise(resolve => setTimeout(resolve, 100));
        expect((view.lastFrame() ?? "").split("\n").every(line => stringWidth(line) <= width)).toBe(true);
    }
    view.stdin.write("\u001b[200~中文🙂\n\u001b[1;2C\u001b[201~"); await flush();
    expect(backs).toBe(0); expect(decisions).toEqual([]);
    view.stdin.write("\r"); await flush();
    expect(decisions).toHaveLength(1);
});
