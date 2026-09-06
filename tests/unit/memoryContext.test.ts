import {describe, expect, test} from "bun:test";
import {formatMemoryFileGuidance} from "../../src/memory/fileGuidance.js";
import {parseMemoryFile} from "../../src/memory/parser.js";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";

describe("Memory context", () => {
    test("每轮只注入有界索引，不自动注入主题正文", async () => {
        await withTempProject(async (cwd) => {
            const memory = createTestMemoryRuntime(cwd, {
                directory: join(cwd, "memory"),
            });
            await memory.upsert({
                key: "feedback-testing-boundaries",
                name: "测试边界",
                description: "测试生产 API 时不要增加测试专用 Options",
                type: "feedback",
                source: "explicit",
                content: "通过组合工厂注入 Fake，不扩张生产调用参数。",
            });

            const context = await memory.contextForTurn("接着设计测试");
            expect(context.block).toContain("feedback-testing-boundaries.md");
            expect(context.block).toContain("Memory directory:");
            expect(context.block).not.toContain("通过组合工厂注入 Fake");
            await memory.close();
        });
    });

    test("用户要求忽略时不注入索引并禁止本轮维护", async () => {
        await withTempProject(async (cwd) => {
            const memory = createTestMemoryRuntime(cwd);
            await memory.upsert({
                key: "user-style",
                name: "回答风格",
                description: "用户喜欢简洁回答",
                type: "user",
                source: "explicit",
                content: "保持简洁。",
            });

            const context = await memory.contextForTurn("这次不要使用任何记忆");
            expect(context.ignoredForTurn).toBe(true);
            expect(context.block).toContain("不得读取、应用、引用、维护或提及");
            expect(context.block).not.toContain("# Pillar Memory");
            await memory.close();
        });
    });
});

for (const source of ["explicit", "automatic"] as const) {
    test(`Memory ${source} 入口提供与真实 parser 一致的完整新建格式`, () => {
        const guidance = formatMemoryFileGuidance(source);
        const raw = /```yaml\n([\s\S]*?)\n```/.exec(guidance)?.[1];
        expect(raw).toBeDefined();
        const entry = parseMemoryFile("/memory/example-topic.md", raw!);
        expect(entry.source).toBe(source);
        expect(entry.key).toBe("example-topic");
        expect(guidance).toContain("不照抄示例日期");
        expect(guidance).toContain("空索引是正常状态");
    });
}
