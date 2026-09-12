import {describe, expect, test} from "bun:test";
import {createInitialHistory} from "../../src/prompt/index.js";
import {withCollaborationMode} from "../../src/prompt/collaboration.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("Host-owned collaboration mode", () => {
    test("每次请求从当前模式生成指令，原始 History 不累积模式记录", () => {
        const history = createInitialHistory("/project", "fixture");
        const before = JSON.stringify(history);
        expect(withCollaborationMode(history, "plan")[0]?.content).toContain("Current mode: Plan");
        expect(withCollaborationMode(history, "build")[0]?.content).toContain("Current mode: Build");
        expect(JSON.stringify(history)).toBe(before);
    });
    test("模型不存在进入或退出 Plan 的工具，写入拒绝无需弹窗", async () => {
        await withTempProject(async cwd => {
            const runtime = createToolRuntime();
            expect(runtime.getToolSchemas().map(tool => tool.function.name)).not.toContain("enter_plan_mode");
            let approvals = 0;
            const ctx = createTestContext(cwd, {collaborationMode: "plan", canUseTool: async () => {
                approvals++; return {behavior: "allow"};
            }});
            expect((await runtime.executeTool("exit_plan_mode", '{"plan":"write"}', ctx, "exit")).outcome).toBe("failed");
            expect((await runtime.executeTool("write_file", '{"path":"a.txt","content":"no"}', ctx, "write")).outcome).toBe("denied");
            expect(approvals).toBe(0);
            expect(await Bun.file(`${cwd}/a.txt`).exists()).toBe(false);
        });
    });
});
