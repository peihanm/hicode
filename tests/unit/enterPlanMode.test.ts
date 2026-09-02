import {describe, expect, test} from "bun:test";
import {enterPlanModeTool} from "../../src/tools/plan/enterPlanMode.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("enter_plan_mode", () => {
    test("进入后只返回面向用户的简短状态，不泄露内部调度规则", async () => {
        await withTempProject(async (cwd) => {
            const context = createTestContext(cwd, {
                permissionMode: "default",
                collaborationMode: "build",
            });
            const result = await enterPlanModeTool.execute(
                {},
                context,
                {toolCallId: "enter-plan"}
            );

            expect(result).toBe(
                "已进入 Plan 模式：先了解项目并整理方案，确认后再开始修改。"
            );
            expect(result).not.toContain("Root");
            expect(result).not.toContain("Explore");
            expect(result).not.toContain("ask_user");
            expect(result).not.toContain("exit_plan_mode");
            expect(context.collaborationMode).toBe("plan");
        });
    });
});
