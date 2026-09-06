import {expect, test} from "bun:test";
import {createTurnCompletionState, formatCompletionContext, formatCompletionReminder, recordToolOutcomes} from "../../src/agent/turnCompletion.js";
import type {ToolCallOutcome} from "../../src/agent/toolBatch.js";
import {createFileChange} from "../../src/fileChanges/index.js";

function shell(id: string, command: string, outcome: "ok" | "failed", cwd = "/project/a"): ToolCallOutcome {
    return {toolCallId: id, name: "bash", argsJson: '{"command":"untrusted original"}', outcome, result: outcome,
        shellExecution: {command, cwd, sandboxPermissions: "use_default"}};
}
function write(path: string): ToolCallOutcome {
    return {toolCallId: path, name: "write_file", argsJson: "{}", outcome: "ok", result: "saved",
        uiData: {type: "file_change", change: createFileChange({path, kind: "create", oldContent: "", newContent: "a"})}};
}

test("只有相同实际命令、cwd 和授权边界的成功替代失败", () => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("a", "bun test", "failed"), shell("b", "bun test", "ok", "/project/b"), shell("c", "bun run check", "ok")], "/project");
    expect(state.failedTools.size).toBe(1);
    recordToolOutcomes(state, [{...shell("d", "bun test", "ok"), shellExecution: {command: "bun test", cwd: "/project/a", sandboxPermissions: "require_escalated"}}], "/project");
    expect(state.failedTools.size).toBe(1);
    recordToolOutcomes(state, [shell("e", "bun test", "ok")], "/project");
    expect(state.failedTools.size).toBe(0);
    expect(formatCompletionReminder(state, "验证通过")).toBeUndefined();
});

test("相关目录修改使验证过期，其他目录修改保留证据，重跑恢复", () => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", "bun test", "ok"), write("b/x.ts")], "/project");
    expect(formatCompletionReminder(state, "测试通过")).toBeUndefined();
    recordToolOutcomes(state, [write("a/x.ts")], "/project");
    expect(formatCompletionContext(state)).toContain("检查已过期");
    expect(formatCompletionReminder(state, "测试通过")).toContain("相关修改");
    expect(formatCompletionReminder(state, "测试此前通过，修改后未重跑")).toBeUndefined();
    recordToolOutcomes(state, [shell("rerun", "bun test", "ok")], "/project");
    expect(formatCompletionReminder(state, "测试通过")).toBeUndefined();
});

test("未知 Shell 副作用和 Command Hook 使证据过期，复合掩盖失败的命令不算项目验证", () => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", "bun test", "ok"), shell("write", "node mutate.js", "failed")], "/project");
    expect(formatCompletionContext(state)).toContain("检查已过期");
    recordToolOutcomes(state, [{...shell("hook", "bun test", "ok"), untrackedWorkspaceEffects: true}], "/project");
    expect([...state.projectChecks.values()].every(check => check.invalidatedAt !== undefined)).toBe(true);
    const fresh = createTurnCompletionState();
    recordToolOutcomes(fresh, [shell("masked", "bun test; true", "ok")], "/project");
    expect(fresh.projectChecks.size).toBe(0);
});

test.each(["node --test", 'node --test "tests/*.test.js"', "npm run test:e2e"])("项目检查 %s 可记录、过期与重跑", (command) => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", command, "ok")], "/project");
    expect(state.projectChecks.size).toBe(1);
    expect(formatCompletionContext(state)).toContain(command);
    recordToolOutcomes(state, [write("a/game.js")], "/project");
    expect(formatCompletionReminder(state, "测试通过")).toContain("相关修改");
    recordToolOutcomes(state, [shell("rerun", command, "ok")], "/project");
    expect(formatCompletionReminder(state, "测试通过")).toBeUndefined();
    recordToolOutcomes(state, [shell("failed", command, "failed")], "/project");
    expect(state.projectChecks.size).toBe(0);
    expect(state.failedTools.size).toBe(1);
});

test.each([
    "node script.js --test", '"node --test"', "node --test --help",
    "node --test; true", "node --test || true", "node --test | tail -20",
    "node --test $(echo tests/game.test.js)", "node --test tests/*.test.js",
])("不从不确定或非测试命令推断通过：%s", (command) => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", command, "ok")], "/project");
    expect(state.projectChecks.size).toBe(0);
});
