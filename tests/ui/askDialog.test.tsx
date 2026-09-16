import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import stringWidth from "string-width";
import {AskDialog} from "../../src/ui/dialogs/AskDialog.js";
import type {PermissionDecision} from "../../src/permissions/index.js";

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test("AskDialog 多题收集完毕后才回流完整答案", async () => {
    const decisions: PermissionDecision[] = [];
    const instance = render(<AskDialog req={{id: 3, question: "选择方案", toolName: "ask_user",
        input: {questions: [
            {question: "选择方案", options: [{label: "A"}, {label: "B"}]},
            {question: "选择环境", options: [{label: "C"}, {label: "D"}]},
        ]}, resolve: decision => decisions.push(decision),
    }} onDone={() => {}}/>);
    await flush();
    expect(instance.lastFrame()).toContain("Confirmation needed · Question 1/2");
    expect(instance.lastFrame()).not.toContain("│");
    instance.stdin.write("\r");
    await flush();
    expect(instance.lastFrame()).toContain("Confirmation needed · Question 2/2");
    expect(decisions).toEqual([]);
    instance.stdin.write("\r");
    await flush();
    expect(instance.lastFrame()).toContain("Confirm answers · 2/2 answered");
    expect(instance.lastFrame()).toContain("Submit answers");
    expect(instance.lastFrame()).not.toContain("│");
    expect(decisions).toEqual([]);
    instance.stdin.write("\r");
    await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"选择方案": "A", "选择环境": "C"}}]);
});

test("AskDialog 回流独立 answers，不替换提问参数", async () => {
    const decisions: PermissionDecision[] = [];
    const instance = render(<AskDialog req={{id: 1, question: "选择方案", toolName: "ask_user",
        input: {questions: [{question: "选择方案", options: [{label: "A"}, {label: "B"}]}]},
        resolve: decision => decisions.push(decision),
    }} onDone={() => {}}/>);
    await flush();
    expect(instance.lastFrame()).toContain("选择方案");
    instance.stdin.write("\r");
    await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"选择方案": "A"}}]);
});

test("AskDialog 将 Esc 取消交给 App，不自行提交部分答案", async () => {
    const decisions: PermissionDecision[] = [];
    const instance = render(<AskDialog req={{id: 2, question: "选择方案", toolName: "ask_user",
        input: {questions: [{question: "选择方案", options: [{label: "A"}, {label: "B"}]}]},
        resolve: decision => decisions.push(decision),
    }} onDone={() => {}}/>);
    await flush();
    instance.stdin.write("\u001b");
    await flush();
    expect(decisions).toEqual([]);
});

test("AskDialog 无边框且长中文说明随终端宽度换行", async () => {
    const description = "标题、右侧状态栏和操作按钮都不见了，页面只剩背景，窗口缩小后说明也应完整显示。";
    const instance = render(<AskDialog req={{id: 4, question: "页面空白", toolName: "ask_user",
        input: {questions: [{question: "打开页面时「啥也没有」具体是哪种情况？", options: [
            {label: "整页全白", description},
            {label: "只有棋盘空白", description: "标题和按钮都在，只有中间棋盘区域为空。"},
        ]}]}, resolve: () => {},
    }} onDone={() => {}}/>);
    let columns = 40;
    Object.defineProperty(instance.stdout, "columns", {configurable: true, get: () => columns});
    for (const width of [40, 80]) {
        columns = width;
        instance.stdout.emit("resize");
        await flush();
        const frame = instance.lastFrame() ?? "";
        expect(frame).not.toContain("│");
        expect(frame).not.toContain("HiCode needs your input");
        expect(frame).not.toContain("Type something");
        expect(frame).toContain("❯ 1. 整页全白");
        expect(frame).toContain("Enter your own answer…");
        expect(frame.replace(/\s/g, "")).toContain(description);
        expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
    }
});

test("AskDialog 自由输入的中文提示、返回选项和提交行为一致", async () => {
    const decisions: PermissionDecision[] = [];
    const instance = render(<AskDialog req={{id: 5, question: "页面空白", toolName: "ask_user",
        input: {questions: [{question: "页面是什么样的？", options: [{label: "整页全白"}]}]},
        resolve: decision => decisions.push(decision),
    }} onDone={() => {}}/>);
    await flush();
    instance.stdin.write("\u001b[B");
    await flush();
    instance.stdin.write("\r");
    await flush();
    expect(instance.lastFrame()).toContain("Enter your answer…");
    expect(instance.lastFrame()).toContain("Esc back to options");
    expect(instance.lastFrame()).not.toContain("│");
    instance.stdin.write("\u001b");
    await flush();
    expect(instance.lastFrame()).toContain("Enter your own answer…");
    expect(decisions).toEqual([]);
    instance.stdin.write("\r");
    await flush();
    instance.stdin.write("只有标题，没有网格");
    await flush();
    instance.stdin.write("\r");
    await flush();
    expect(decisions).toEqual([]);
    expect(instance.lastFrame()).toContain("❯ Confirm input");
    instance.stdin.write("\r");
    await flush();
    expect(decisions).toEqual([{behavior: "allow", answers: {"页面是什么样的？": "只有标题，没有网格"}}]);
});
