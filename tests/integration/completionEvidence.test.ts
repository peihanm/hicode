import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {Message} from "../../src/llm/types.js";

test("真实 Bash 失败、文件修复、同一检查通过后直接收尾", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "verify.test.ts"), 'import {test,expect} from "bun:test"; test("flag",async()=>expect(await Bun.file("flag.txt").exists()).toBe(true));');
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: "bun test verify.test.ts"}, "failed"),
            assistantToolCall("write_file", {path: "flag.txt", content: "fixed"}, "fix"),
            assistantToolCall("bash", {command: "bun test verify.test.ts"}, "passed"),
            options => {
                const context = options.messages.map(message => message.content).join("\n");
                expect(context).toContain("检查通过");
                expect(context).not.toContain("未解决 bash (failed)");
                return assistantText("修复完成，同一检查已通过");
            },
        ]);
        const history: Message[] = [{role: "system", content: "test"}];
        const result = await runAgentForTest("修复检查", history, () => {}, createTestContext(cwd), {callLLM: fake.callLLM});
        expect(result.reply).toBe("修复完成，同一检查已通过");
        expect(fake.calls).toHaveLength(4);
        expect(history.filter(m => m.role === "tool").map(m => m.content).join("\n")).toContain("1 pass");
        expect(history.some(m => m.content?.includes("当前完成证据"))).toBe(false);
    });
});

test("最后一次迭代不丢弃含有效结论的回答", async () => {
    await withTempProject(async cwd => {
        const fake = createFakeLLM([
            assistantToolCall("check", {}, "failure"),
            assistantText("已定位配置错误，检查仍然失败，暂未完成修复。"),
        ]);
        const history: Message[] = [{role: "system", content: "test"}];
        const result = await runAgentForTest("检查", history, () => {}, createTestContext(cwd), {
            callLLM: fake.callLLM, maxIterations: 2,
            executeTool: async () => ({modelContent: "bad config", displayContent: "bad config", outcome: "failed"}),
        });
        expect(result.reply).toContain("已定位配置错误");
        expect(history.at(-1)?.content).toContain("已定位配置错误");
        expect(fake.calls).toHaveLength(2);
    });
});
