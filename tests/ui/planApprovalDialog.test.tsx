import {afterEach, describe, expect, mock, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import type {PermissionDecision, PermissionMode} from "../../src/permissions/index.js";
import {PlanApprovalDialog} from "../../src/ui/dialogs/PlanApprovalDialog.js";

afterEach(() => cleanup());

const ENTER = "\r";
const DOWN = "\u001B[B";
const ESCAPE = "\u001B";

async function flush(ms = 20): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function renderDialog(options: {
    plan?: unknown;
    bypassPermissionsAvailable?: boolean;
} = {}) {
    const decisions: PermissionDecision[] = [];
    const approvedModes: PermissionMode[] = [];
    const onDone = mock(() => {});
    const instance = render(
        <PlanApprovalDialog
            req={{
                question: "是否批准？",
                toolName: "exit_plan_mode",
                input: {plan: options.plan ?? "# 实施计划\n\n1. 修改代码\n2. 运行测试"},
                allowAddToAllowList: false,
                resolve: (decision) => decisions.push(decision),
            }}
            bypassPermissionsAvailable={options.bypassPermissionsAvailable}
            onApprove={(mode) => approvedModes.push(mode)}
            onDone={onDone}
        />
    );
    return {instance, decisions, approvedModes, onDone};
}

describe("PlanApprovalDialog", () => {
    test("展示计划和三个专用选项，默认批准进入 acceptEdits", async () => {
        const harness = renderDialog();
        await flush();

        const frame = harness.instance.lastFrame() ?? "";
        expect(frame).toContain("Ready to code?");
        expect(frame).toContain("实施计划");
        expect(frame).toContain("1. Yes, auto-accept edits");
        expect(frame).toContain("2. Yes, manually approve edits");
        expect(frame).toContain("3. No, keep planning");
        expect(frame).not.toContain("don't ask again for this project");

        harness.instance.stdin.write(ENTER);
        await flush();

        expect(harness.approvedModes).toEqual(["acceptEdits"]);
        expect(harness.decisions).toEqual([{behavior: "allow"}]);
        expect(harness.onDone).toHaveBeenCalledTimes(1);
    });

    test("第二项批准后进入 default", async () => {
        const harness = renderDialog();
        await flush();
        harness.instance.stdin.write(DOWN);
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();

        expect(harness.approvedModes).toEqual(["default"]);
        expect(harness.decisions).toEqual([{behavior: "allow"}]);
    });

    test("会话已允许 bypassPermissions 时明确提供对应批准选项", async () => {
        const harness = renderDialog({bypassPermissionsAvailable: true});
        await flush();
        expect(harness.instance.lastFrame()).toContain(
            "1. Yes, and bypass permissions"
        );

        harness.instance.stdin.write(ENTER);
        await flush();
        expect(harness.approvedModes).toEqual(["bypassPermissions"]);
    });

    test("dontAsk 不会成为 Plan 批准后的恢复选项", async () => {
        const harness = renderDialog();
        await flush();

        const frame = harness.instance.lastFrame() ?? "";
        expect(frame).toContain("1. Yes, auto-accept edits");
        expect(frame).not.toContain("don't ask for permissions");
    });

    test("继续规划要求非空反馈，并把原文作为拒绝原因返回", async () => {
        const harness = renderDialog();
        await flush();
        harness.instance.stdin.write(DOWN);
        await flush();
        harness.instance.stdin.write(DOWN);
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();

        expect(harness.instance.lastFrame()).toContain("Tell pillar what to change");
        harness.instance.stdin.write(ENTER);
        await flush();
        expect(harness.decisions).toEqual([]);

        harness.instance.stdin.write("补充回滚和测试方案");
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();
        expect(harness.approvedModes).toEqual([]);
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
        harness.instance.stdin.write(DOWN);
        await flush();
        harness.instance.stdin.write(ENTER);
        await flush();
        harness.instance.stdin.write(ESCAPE);
        await flush();
        expect(harness.instance.lastFrame()).toContain("3. No, keep planning");
        expect(harness.decisions).toEqual([]);

        harness.instance.stdin.write(ESCAPE);
        await flush();
        expect(harness.decisions).toEqual([{
            behavior: "deny",
            message: "用户取消计划审批，继续留在 Plan 模式",
        }]);
    });

    test("长计划只截断 UI 预览，非法输入不能被批准", async () => {
        const longPlan = `# 长计划\n${"a".repeat(4500)}`;
        const longHarness = renderDialog({plan: longPlan});
        await flush();
        expect(longHarness.instance.lastFrame()).toContain("计划预览已截断");
        cleanup();

        const invalid = renderDialog({plan: 42});
        await flush();
        expect(invalid.instance.lastFrame()).toContain("输入缺少有效 plan");
        invalid.instance.stdin.write(ESCAPE);
        await flush();
        expect(invalid.decisions[0]?.behavior).toBe("deny");
    });
});
