import {fileURLToPath} from "node:url";
import type {EvalCase} from "../src/types.js";

const hiddenVerifier = fileURLToPath(
    new URL("../verifiers/leetcodeWeb.ts", import.meta.url)
);

export const leetcodeWebCase: EvalCase = {
    id: "leetcode-web",
    description: "搭建一个可在本地编写并真实运行 Two Sum 代码的 GitHub 白色风格网站",
    fixtureDirectory: fileURLToPath(
        new URL("../fixtures/leetcode-web-starter/", import.meta.url)
    ),
    prompt: [
        "我想做一个能让我自己刷 LeetCode 的网站。请搭建可以真实运行的第一版整体框架：只做一道 Two Sum，用户能在本地 Web 页面编写 JavaScript 解法、点击运行并看到逐项测试结果。配色使用 GitHub 白色风格。",
        "项目使用 Bun 和 TypeScript，不安装外部依赖。`bun run start` 必须启动服务；监听 `HOST`（默认 127.0.0.1）和 `PORT`（默认 3000）。",
        "必须创建 server.ts、public/index.html、public/app.js、public/styles.css。页面至少包含题目描述、示例、代码 textarea、运行按钮、状态和测试结果区，并能调用后端。",
        "POST /api/run 接收 JSON `{code: string}`。代码定义 `function twoSum(nums, target)`。服务必须在隔离子进程中对至少 4 组测试执行代码，并返回 `{ok, passed, total, results, error?}`；错误解法应返回失败测试，语法/运行错误应返回 ok=false 和可读错误，死循环必须在 2 秒内终止且不能拖死 Web 服务。",
        "GET / 返回页面，静态资源由同一服务提供。补充自动化测试并实际运行验证。不要提交 Git commit。",
    ].join("\n"),
    permissionMode: "acceptEdits",
    maxIterations: 40,
    timeoutMs: 900_000,
    budget: {
        maxIterations: 32,
        maxInputTokens: 500_000,
        maxOutputTokens: 120_000,
        maxTotalTokens: 620_000,
        maxDurationMs: 720_000,
    },
    requiredChangedPaths: [
        "server.ts",
        "public/index.html",
        "public/app.js",
        "public/styles.css",
    ],
    forbiddenChangedPrefixes: [".env", "node_modules/"],
    commands: [
        {
            id: "visible-tests",
            label: "Agent 创建的 Bun 测试通过",
            argv: ["bun", "test"],
            timeoutMs: 30_000,
        },
        {
            id: "hidden-leetcode-web-contract",
            label: "隐藏 Web、执行隔离与视觉契约通过",
            argv: ["bun", hiddenVerifier],
            timeoutMs: 30_000,
        },
    ],
};
