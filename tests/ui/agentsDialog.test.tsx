import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {App} from "../../src/ui/App.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createSubagentRegistry} from "../../src/subagents/index.js";

afterEach(() => cleanup());

describe("Agents dialog", () => {
    test("/agents 打开交互管理界面，Esc 返回主输入框", async () => {
        await withTempProject(async (cwd) => {
            const instance = render(
                <App
                    resources={createTestRuntimeResources(cwd)}
                />
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            instance.stdin.write("/agents");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));

            const dialog = instance.lastFrame() ?? "";
            expect(dialog).toContain("◆ Agents");
            expect(dialog).toContain("GeneralPurpose");
            expect(dialog).toContain("创建新 Agent");
            expect(dialog).toContain("重新加载 Agent 文件");

            instance.stdin.write("\u001b");
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(instance.lastFrame()).toContain("new session");
        });
    });

    test("管理界面提供加载问题入口", async () => {
        await withTempProject(async (cwd) => {
            const subagents = createSubagentRegistry({
                definitions: [],
                issues: [{
                    source: "project",
                    path: `${cwd}/.pillar/agents/broken.md`,
                    severity: "error",
                    field: "tools",
                    message: "当前 Runtime 不存在工具: missing",
                }],
            });
            const instance = render(
                <App
                    resources={createTestRuntimeResources(cwd, {subagents})}
                />
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            instance.stdin.write("/agents");
            await new Promise((resolve) => setTimeout(resolve, 10));
            instance.stdin.write("\r");
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(instance.lastFrame()).toContain("加载问题 (1)");
        });
    });
});
