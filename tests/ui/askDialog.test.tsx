import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
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
    instance.stdin.write("\r");
    await flush();
    expect(decisions).toEqual([]);
    instance.stdin.write("\r");
    await flush();
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
