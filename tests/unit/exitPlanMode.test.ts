import {describe, expect, test} from "bun:test";
import {exitPlanModeTool} from "../../src/tools/plan/exitPlanMode.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("exit_plan_mode", () => {
    test("只在 Plan Mode 接受非空计划", async () => {
        await withTempProject(async (cwd) => {
            const defaultContext = createTestContext(cwd, {
                permissionMode: "default",
            });
            expect(await exitPlanModeTool.checkPermissions?.(
                {plan: "实施计划"},
                defaultContext
            )).toEqual({
                behavior: "deny",
                message: "exit_plan_mode 只能在 Plan 模式下使用",
            });

            const planContext = createTestContext(cwd, {
                permissionMode: "plan",
            });
            expect(await exitPlanModeTool.checkPermissions?.(
                {plan: "实施计划"},
                planContext
            )).toEqual(expect.objectContaining({behavior: "ask"}));
        });
    });

    test("execute 只生成 Approved Plan，权限模式由审批 UI 选择", async () => {
        await withTempProject(async (cwd) => {
            const context = createTestContext(cwd, {
                permissionMode: "plan",
            });
            const result = await exitPlanModeTool.execute(
                {plan: "  1. 修改代码\n2. 运行测试  "},
                context,
                {toolCallId: "exit-plan"}
            );

            expect(result).toContain("用户已批准计划");
            expect(result).toContain("1. 修改代码\n2. 运行测试");
            expect(context.permissionMode).toBe("plan");
        });
    });
});
