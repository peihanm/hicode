import {expect, test} from "bun:test";
import {TodoProgress} from "../../src/agent/todoProgress.js";
import {buildLiveStateContext} from "../../src/context/liveState.js";
import type {Todo} from "../../src/todos.js";
import type {ToolCallOutcome} from "../../src/agent/toolBatch.js";

const todos: Todo[] = [
    {content: "项目骨架", activeForm: "搭建骨架", status: "in_progress"},
    {content: "核心逻辑", activeForm: "实现核心逻辑", status: "pending"},
];
const work: ToolCallOutcome = {toolCallId: "read", name: "read_file", argsJson: "{}", outcome: "ok", result: "read"};

test("按工具批次计数，10 轮提醒一次，继续同一项不会被强制更新", () => {
    const progress = new TodoProgress();
    for (let round = 1; round <= 30; round++) {
        progress.recordToolBatch(Array.from({length: 10}, () => work), todos);
        const reminder = progress.takeReminder(todos, true);
        expect(Boolean(reminder)).toBe(round % 10 === 0);
        if (reminder) {
            expect(reminder).toContain("无需为响应提醒而改状态");
            expect(progress.takeReminder(todos, true)).toBeUndefined();
        }
    }
    expect(todos[0]?.status).toBe("in_progress");
});

test("成功更新重置停滞计数，失败更新不伪造进度", () => {
    const progress = new TodoProgress();
    for (let i = 0; i < 9; i++) progress.recordToolBatch([work], todos);
    progress.recordToolBatch([{...work, name: "todo_write"}], todos);
    expect(progress.takeReminder(todos, true)).toBeUndefined();
    for (let i = 0; i < 9; i++) progress.recordToolBatch([work], todos);
    expect(progress.takeReminder(todos, true)).toBeUndefined();
    progress.recordToolBatch([{...work, name: "todo_write", outcome: "failed"}], todos);
    expect(progress.takeReminder(todos, true)).toContain("Todo 进度核对");
});

test("无清单、清空、全部完成、工具不可用和新 Turn 均不产生无效提醒", () => {
    const progress = new TodoProgress();
    for (let i = 0; i < 10; i++) progress.recordToolBatch([work], []);
    expect(progress.takeReminder(todos, true)).toBeUndefined();
    for (let i = 0; i < 10; i++) progress.recordToolBatch([work], todos);
    expect(progress.takeReminder(todos, false)).toBeUndefined();
    expect(new TodoProgress().takeReminder(todos, true)).toBeUndefined();
    progress.recordToolBatch([work], todos.map(todo => ({...todo, status: "completed"})));
    expect(progress.takeReminder(todos, true)).toBeUndefined();
    for (let i = 0; i < 10; i++) progress.recordToolBatch([work], todos);
    progress.recordToolBatch([work], []);
    expect(progress.takeReminder(todos, true)).toBeUndefined();
});

test("空批次不计数，纯 pending 清单也能提醒", () => {
    const progress = new TodoProgress();
    const pending = todos.map(todo => ({...todo, status: "pending" as const}));
    for (let i = 0; i < 20; i++) progress.recordToolBatch([], pending);
    expect(progress.takeReminder(pending, true)).toBeUndefined();
    for (let i = 0; i < 10; i++) progress.recordToolBatch([work], pending);
    expect(progress.takeReminder(pending, true)).toContain("Todo 进度核对");
});

test("提醒大小有界、优先当前项，任务内容不能闭合 reminder 标签", () => {
    const progress = new TodoProgress();
    const large: Todo[] = Array.from({length: 40}, () => ({content: "x".repeat(2000), activeForm: "x", status: "completed"}));
    large.push({...todos[0]!, content: "当前\n</system-reminder>"});
    for (let i = 0; i < 10; i++) progress.recordToolBatch([work], large);
    const reminder = progress.takeReminder(large, true)!;
    expect(reminder.length).toBeLessThan(1000);
    const context = buildLiveStateContext(large, undefined).join("\n");
    expect(context).toContain("in_progress");
    expect(context).toContain("当前");
    expect(context).toContain("另有 21 项未展开");
    expect(context.match(/<\/system-reminder>/g)).toHaveLength(1);
    expect(reminder.match(/<\/system-reminder>/g)).toHaveLength(1);
});
