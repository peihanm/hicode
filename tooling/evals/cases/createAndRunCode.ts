import {fileURLToPath} from "node:url";
import type {EvalCase} from "../src/types.js";

export const createAndRunCodeCase: EvalCase = {
    id: "create-and-run-code",
    description: "从最小项目创建 Fibonacci 实现、测试并真实运行",
    fixtureDirectory: fileURLToPath(
        new URL("../fixtures/fibonacci-starter/", import.meta.url)
    ),
    prompt: [
        "完成当前 TypeScript 项目的 Fibonacci 功能。",
        "创建 src/fibonacci.ts，导出 fibonacci(n: number): number；创建 tests/fibonacci.test.ts。",
        "要求 fibonacci(0)=0、fibonacci(1)=1，支持非负整数，负数或非整数必须抛出错误。",
        "运行 bun test 验证。完成后说明修改和真实验证结果。不要提交 Git commit。",
    ].join("\n"),
    permissionMode: "default",
    maxIterations: 12,
    timeoutMs: 180_000,
    budget: {
        maxIterations: 8,
        maxInputTokens: 80_000,
        maxOutputTokens: 3_000,
        maxTotalTokens: 85_000,
        maxDurationMs: 60_000,
    },
    requiredChangedPaths: ["src/fibonacci.ts", "tests/fibonacci.test.ts"],
    forbiddenChangedPrefixes: ["package.json", "README.md"],
    commands: [
        {
            id: "visible-tests",
            label: "Agent 创建的 Bun 测试通过",
            argv: ["bun", "test"],
            timeoutMs: 30_000,
        },
        {
            id: "hidden-fibonacci-contract",
            label: "隐藏 Fibonacci 契约通过",
            argv: [
                "bun",
                "-e",
                [
                    'import {fibonacci} from "./src/fibonacci.ts";',
                    "const expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55];",
                    "for (const [index, value] of expected.entries()) {",
                    '  if (fibonacci(index) !== value) throw new Error(`fibonacci(${index})`);',
                    "}",
                    "for (const invalid of [-1, 1.5]) {",
                    "  let threw = false;",
                    "  try { fibonacci(invalid); } catch { threw = true; }",
                    '  if (!threw) throw new Error(`invalid ${invalid}`);',
                    "}",
                    'console.log("HIDDEN_FIBONACCI_OK");',
                ].join(" "),
            ],
            timeoutMs: 15_000,
        },
    ],
};
