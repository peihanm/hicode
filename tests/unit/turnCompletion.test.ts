import {expect, test} from "bun:test";
import {createTurnCompletionState, formatCompletionContext, recordToolOutcomes} from "../../src/agent/turnCompletion.js";
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

test("失败不形成额外未解决状态或阻止收尾，后续失败撤销同一检查的通过证据", () => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("failed", "bun test", "failed")], "/project");
    expect(formatCompletionContext(state)).toBeUndefined();
    recordToolOutcomes(state, [shell("passed", "bun test", "ok")], "/project");
    expect(formatCompletionContext(state)).toContain("检查通过");
    recordToolOutcomes(state, [shell("failed-again", "bun test", "failed")], "/project");
    expect(state.projectChecks.size).toBe(0);
    expect(formatCompletionContext(state)).toBeUndefined();
});

test("相关目录修改使验证过期，其他目录修改保留证据，重跑恢复", () => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", "bun test", "ok"), write("b/x.ts")], "/project");
    recordToolOutcomes(state, [write("a/x.ts")], "/project");
    expect(formatCompletionContext(state)).toContain("检查已过期");
    recordToolOutcomes(state, [shell("rerun", "bun test", "ok")], "/project");
    expect(formatCompletionContext(state)).not.toContain("检查已过期");
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

test("后台启动仍使检查过期，但不维护生命周期提示或阻止等价收尾", () => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", "bun test", "ok"), {
        ...shell("background", "bun test", "ok"),
        argsJson: '{"command":"bun test","run_in_background":true}',
        result: "Task: background-1\nStatus: running",
    }], "/project");
    expect(formatCompletionContext(state)).toContain("检查已过期");
    expect(formatCompletionContext(state)).not.toContain("后台任务");
});

test.each(["node --test", 'node --test "tests/*.test.js"', "npm run test:e2e"])("项目检查 %s 可记录、过期与重跑", (command) => {
    const state = createTurnCompletionState();
    recordToolOutcomes(state, [shell("check", command, "ok")], "/project");
    expect(state.projectChecks.size).toBe(1);
    expect(formatCompletionContext(state)).toContain(command);
    recordToolOutcomes(state, [write("a/game.js")], "/project");
    expect(formatCompletionContext(state)).toContain("检查已过期");
    recordToolOutcomes(state, [shell("rerun", command, "ok")], "/project");
    expect(formatCompletionContext(state)).not.toContain("检查已过期");
    recordToolOutcomes(state, [shell("failed", command, "failed")], "/project");
    expect(state.projectChecks.size).toBe(0);
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
