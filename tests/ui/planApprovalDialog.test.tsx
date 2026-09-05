import {afterEach, describe, expect, mock, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import type {PermissionDecision} from "../../src/permissions/index.js";
import {PlanApprovalDialog} from "../../src/ui/dialogs/PlanApprovalDialog.js";

afterEach(() => cleanup());

const ENTER = "\r";
const DOWN = "\u001B[B";
const ESCAPE = "\u001B";

async function flush(ms = 20): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function renderDialog(options: {plan?: unknown} = {}) {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const instance = render(
        <PlanApprovalDialog
            req={{
          id: 1,
                question: "是否批准？",
                toolName: "exit_plan_mode",
                input: {plan: options.plan ?? "# 实施计划\n\n1. 修改代码\n2. 运行测试"},
                allowAddToAllowList: false,
                resolve: (decision) => decisions.push(decision),
            }}
            onDone={onDone}
        />
    );
    return {instance, decisions, onDone};
}

describe("PlanApprovalDialog", () => {
    test("窄屏长 Markdown 可翻页，resize 后末尾与版本仍可审阅", async () => {
        const harness = renderDialog({plan: "# 标题\n```ts\n" + "const text = '中文';\n".repeat(180) + "```\n风险末尾"});
        let columns = 34;
        let rows = 20;
        Object.defineProperties(harness.instance.stdout, {
            columns: {configurable: true, get: () => columns}, rows: {configurable: true, get: () => rows},
        });
        harness.instance.stdout.emit("resize");
        await flush(90);
        harness.instance.stdin.write("G");
        await flush();
        expect(harness.instance.lastFrame()).toContain("风险末尾");
        const version = /版本 ([a-f0-9]+)/.exec(harness.instance.lastFrame() ?? "")?.[1];
        columns = 48;
        rows = 26;
        harness.instance.stdout.emit("resize");
        await flush(90);
        harness.instance.stdin.write("G");
        await flush();
        expect(harness.instance.lastFrame()).toContain("风险末尾");
        expect(harness.instance.lastFrame()).toContain(`版本 ${version}`);
        harness.instance.stdin.write("g");
        await flush();
        expect(harness.instance.lastFrame()).toContain("标题");
        expect(harness.decisions).toEqual([]);
    });
    test("展示计划和两个专用操作，默认选择立即构建", async () => {
        const harness = renderDialog();
        await flush();

        const frame = harness.instance.lastFrame() ?? "";
        expect(frame).not.toContain("READY TO BUILD?");
        expect(frame).toContain("PLAN");
        expect(frame).toContain("ACTION");
        expect(frame).toContain("实施计划");
        expect(frame).toContain("Build now");
        expect(frame).not.toContain("current permissions");
        expect(frame).toContain("Keep planning");
        expect(frame).not.toContain("don't ask again for this project");
        expect(frame).not.toContain("Would you like to proceed?");
        expect(frame.split("\n").some((line) => line.startsWith("│"))).toBe(false);

        harness.instance.stdin.write(ENTER);
        await flush();

        expect(harness.decisions).toEqual([{behavior: "allow"}]);
        expect(harness.onDone).toHaveBeenCalledTimes(1);
    });

    test("审批不展示或改变权限 Profile", async () => {
        const harness = renderDialog();
        await flush();

        const frame = harness.instance.lastFrame() ?? "";
        expect(frame).not.toContain("permissions");
        expect(frame).not.toContain("bypass permissions");
        expect(frame).not.toContain("auto-accept edits");
    });

    test("继续规划要求非空反馈，并把原文作为拒绝原因返回", async () => {
        const harness = renderDialog();
        await flush();
        harness.instance.stdin.write(DOWN);
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();

        expect(harness.instance.lastFrame()).toContain("FEEDBACK");
        expect(harness.instance.lastFrame()).toContain("Tell Pillar what to change");
        harness.instance.stdin.write(ENTER);
        await flush();
        expect(harness.decisions).toEqual([]);

        harness.instance.stdin.write("补充回滚和测试方案");
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();
        expect(harness.decisions).toEqual([{
            behavior: "deny",
            message: "补充回滚和测试方案",
        }]);
    });

    test("反馈态 Esc 返回选项，根菜单 Esc 取消审批", async () => {
        const harness = renderDialog();
        await flush();
        harness.instance.stdin.write(DOWN);
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();
        harness.instance.stdin.write(ESCAPE);
        await flush();
        expect(harness.instance.lastFrame()).toContain("Keep planning");
        expect(harness.decisions).toEqual([]);

        harness.instance.stdin.write(ESCAPE);
        await flush();
        expect(harness.decisions).toEqual([{
            behavior: "deny",
            message: "用户取消计划审批，继续留在 Plan 模式",
        }]);
    });

    test("长计划能在批准前翻到末尾，非法输入不能被批准", async () => {
        const longPlan = `# 长计划\n${"a".repeat(4500)}\n最终风险：回滚数据库`;
        const longHarness = renderDialog({plan: longPlan});
        await flush();
        expect(longHarness.instance.lastFrame()).toContain("全文");
        longHarness.instance.stdin.write("G");
        await flush();
        expect(longHarness.instance.lastFrame()).toContain("最终风险：回滚数据库");
        expect(longHarness.decisions).toEqual([]);
        cleanup();

        const invalid = renderDialog({plan: 42});
        await flush();
        expect(invalid.instance.lastFrame()).toContain("输入缺少有效 plan");
        invalid.instance.stdin.write(ESCAPE);
        await flush();
        expect(invalid.decisions[0]?.behavior).toBe("deny");
    });
});
