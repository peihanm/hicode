import {fileURLToPath} from "node:url";
import type {EvalCase} from "../src/types.js";

export const fixFailingTestCase: EvalCase = {
    id: "fix-failing-test",
    description: "定位并修复一个现有 TypeScript 计数器实现，保持测试不变",
    fixtureDirectory: fileURLToPath(
        new URL("../fixtures/broken-counter/", import.meta.url)
    ),
    prompt: [
        "修复当前 TypeScript 项目中的计数器实现。",
        "要求：不要修改 tests/、package.json 或 README.md；定位真实实现问题并修复；运行 bun test 验证。",
        "完成后简洁说明根因、修改和真实验证结果。不要提交 Git commit。",
    ].join("\n"),
    permissionMode: "ask",
    maxIterations: 12,
    timeoutMs: 180_000,
    budget: {
        maxIterations: 10,
        maxInputTokens: 110_000,
        maxOutputTokens: 3_000,
        maxTotalTokens: 115_000,
        maxDurationMs: 60_000,
    },
    requiredChangedPaths: ["src/counter.ts"],
    forbiddenChangedPrefixes: ["tests/", "package.json", "README.md"],
    commands: [
        {
            id: "visible-tests",
            label: "现有 Bun 测试通过",
            argv: ["bun", "test"],
            timeoutMs: 30_000,
        },
        {
            id: "hidden-counter-contract",
            label: "隐藏计数器契约通过",
            argv: [
                "bun",
                "-e",
                [
                    'import {createCounter} from "./src/counter.ts";',
                    "const counter = createCounter(2);",
                    'if (counter.value() !== 2) throw new Error("initial value");',
                    'if (counter.increment() !== 3) throw new Error("increment return");',
                    'if (counter.increment() !== 4) throw new Error("second increment");',
                    'if (counter.decrement() !== 3) throw new Error("decrement");',
                    'if (counter.reset() !== 2) throw new Error("reset");',
                    'console.log("HIDDEN_COUNTER_OK");',
                ].join(" "),
            ],
            timeoutMs: 15_000,
        },
    ],
};
