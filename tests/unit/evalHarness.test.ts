import {describe, expect, test} from "bun:test";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
    collectWorkspaceDiff,
    prepareEvalRun,
} from "../../evals/src/artifacts.js";
import {getEvalCase, listEvalCases} from "../../evals/src/cases.js";
import {
    evaluateEvalBudget,
    mergeEvalBudget,
} from "../../evals/src/budget.js";
import {runEvalCase} from "../../evals/src/runner.js";
import {classifyEvalFailure} from "../../evals/src/failure.js";
import {
    createEvalLiveStatus,
    formatEvalHeartbeat,
    reduceEvalLiveStatus,
} from "../../evals/src/liveStatus.js";
import {refreshEvalTrendReport} from "../../evals/src/trends.js";
import {
    createVerifierEnvironment,
    runProcess,
} from "../../evals/src/process.js";
import {runEvalVerification} from "../../evals/src/verifier.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("SDK Eval Harness", () => {
    test("公开首批 Case 并拒绝未知 Case", () => {
        expect(listEvalCases().map((item) => item.id)).toEqual([
            "fix-failing-test",
            "create-and-run-code",
            "leetcode-web",
        ]);
        expect(() => getEvalCase("missing")).toThrow("未知 Eval Case");
    });

    test("LeetCode Web 隐藏验证器真实启动服务并覆盖执行隔离", async () => {
        await withTempProject(async (root) => {
            const evalCase = getEvalCase("leetcode-web");
            const command = evalCase.commands.find(
                (candidate) => candidate.id === "hidden-leetcode-web-contract"
            );
            expect(command).toBeDefined();
            if (!command) return;
            const result = await runProcess(command.argv, {
                cwd: fileURLToPath(
                    new URL(
                        "../fixtures/evalLeetcodeWeb/",
                        import.meta.url
                    )
                ),
                env: await createVerifierEnvironment(join(root, "verifier-home")),
                timeoutMs: 20_000,
            });
            expect(result.exitCode).toBe(0);
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain("HIDDEN_LEETCODE_WEB_OK");
        });
    }, 25_000);

    test("合并预算并把超额或缺失指标投影成独立断言", () => {
        const limits = mergeEvalBudget(
            {
                maxIterations: 5,
                maxInputTokens: 100,
                maxOutputTokens: 20,
                maxTotalTokens: 120,
                maxDurationMs: 1_000,
            },
            {maxTotalTokens: 90}
        );
        expect(limits).toEqual({
            maxIterations: 5,
            maxInputTokens: 100,
            maxOutputTokens: 20,
            maxTotalTokens: 90,
            maxDurationMs: 1_000,
        });
        const evaluated = evaluateEvalBudget(
            {
                threadId: "thread",
                turnId: "turn",
                items: [],
                finalResponse: "done",
                usage: {
                    inputTokens: 80,
                    outputTokens: 15,
                    totalTokens: 95,
                    estimated: false,
                },
                stopReason: "completed",
                iterations: 4,
                durationMs: 800,
            },
            limits
        );
        expect(evaluated.summary.passed).toBe(false);
        expect(
            evaluated.assertions.find(
                (assertion) => assertion.id === "budget:total-tokens"
            )
        ).toMatchObject({passed: false, expected: "<= 90", actual: "95"});
        expect(
            evaluated.assertions.filter((assertion) => assertion.passed)
        ).toHaveLength(4);

        const missingUsage = evaluateEvalBudget(undefined, {
            maxInputTokens: 100,
        });
        expect(missingUsage.summary.passed).toBe(false);
        expect(missingUsage.assertions[0]).toMatchObject({
            passed: false,
            actual: "missing",
        });
    });

    test("硬中断优先于预算超额分类", () => {
        const assertions = [{
            id: "budget:duration-ms",
            label: "Turn 耗时不超过预算",
            passed: false,
        }];
        expect(classifyEvalFailure(undefined, assertions, {
            threadId: "thread",
            turnId: "turn",
            items: [],
            finalResponse: "",
            usage: null,
            stopReason: "interrupted",
            abortReason: "timeout",
            iterations: 1,
            durationMs: 1_000,
        })).toBe("runtime");
        expect(classifyEvalFailure(undefined, assertions, undefined))
            .toBe("budget");
        expect(classifyEvalFailure({
            code: "runtime_error",
            message: "LLM API 错误（已尝试 3 次）: 429 - 余额不足或无可用资源包",
        }, assertions, undefined)).toBe("provider");
    });

    test("实时状态区分模型活跃、安静与停滞", () => {
        let status = createEvalLiveStatus(0);
        status = reduceEvalLiveStatus(status, {
            type: "turn.started",
            turnId: "turn",
            inputSummary: "task",
            protocolVersion: 1,
            sequence: 1,
            threadId: "thread",
            emittedAt: new Date(0).toISOString(),
        });
        status = reduceEvalLiveStatus(status, {
            type: "turn.progress",
            turnId: "turn",
            phase: "reasoning",
            outputCharacters: 1_024,
            estimatedOutputTokens: 256,
            protocolVersion: 1,
            sequence: 2,
            threadId: "thread",
            emittedAt: new Date(10_000).toISOString(),
        });
        expect(formatEvalHeartbeat(status, 15_000)).toContain(
            "active | model reasoning | ~256 output tokens"
        );
        expect(formatEvalHeartbeat(status, 50_000)).toContain("quiet");
        expect(formatEvalHeartbeat(status, 131_000)).toContain("stalled");

        status = reduceEvalLiveStatus(status, {
            type: "item.started",
            turnId: "turn",
            item: {
                id: "tool:1",
                type: "tool_call",
                status: "in_progress",
                toolCallId: "call-1",
                name: "write_file",
                category: "builtin",
                arguments: {path: "server.ts"},
            },
            protocolVersion: 1,
            sequence: 3,
            threadId: "thread",
            emittedAt: new Date(132_000).toISOString(),
        });
        expect(formatEvalHeartbeat(status, 132_100)).toContain(
            "active | running write_file"
        );
    });

    test("从不可变 Run report 重建按 Case、Provider 和模型分组的历史趋势", async () => {
        await withTempProject(async (root) => {
            const firstDirectory = join(root, "runs", "run-1");
            const secondDirectory = join(root, "runs", "run-2");
            const malformedDirectory = join(root, "runs", "run-bad");
            await Promise.all([
                mkdir(firstDirectory, {recursive: true}),
                mkdir(secondDirectory, {recursive: true}),
                mkdir(malformedDirectory, {recursive: true}),
            ]);
            await Promise.all([
                writeFile(
                    join(firstDirectory, "report.json"),
                    JSON.stringify({
                        schemaVersion: 1,
                        runId: "run-1",
                        caseId: "case-a",
                        passed: true,
                        finishedAt: "2026-08-30T01:00:00.000Z",
                        durationMs: 100,
                        source: "qwen",
                        model: "model-a",
                        result: {
                            iterations: 2,
                            usage: {
                                inputTokens: 10,
                                outputTokens: 5,
                                totalTokens: 15,
                            },
                        },
                    })
                ),
                writeFile(
                    join(secondDirectory, "report.json"),
                    JSON.stringify({
                        schemaVersion: 1,
                        runId: "run-2",
                        caseId: "case-a",
                        passed: false,
                        failureKind: "budget",
                        finishedAt: "2026-08-30T02:00:00.000Z",
                        durationMs: 300,
                        source: "qwen",
                        model: "model-a",
                        budget: {passed: false},
                        result: {
                            iterations: 4,
                            usage: {
                                inputTokens: 30,
                                outputTokens: 7,
                                totalTokens: 37,
                            },
                        },
                    })
                ),
                writeFile(join(malformedDirectory, "report.json"), "{}"),
            ]);

            const [report, concurrentReport] = await Promise.all([
                refreshEvalTrendReport(root),
                refreshEvalTrendReport(root),
            ]);
            expect(report.runCount).toBe(2);
            expect(concurrentReport.runCount).toBe(2);
            expect(report.skippedReportCount).toBe(1);
            expect(report.issues).toHaveLength(1);
            expect(report.groups).toHaveLength(1);
            expect(report.groups[0]).toMatchObject({
                caseId: "case-a",
                source: "qwen",
                model: "model-a",
                runCount: 2,
                passedCount: 1,
                passRate: 0.5,
                averages: {
                    durationMs: 200,
                    iterations: 3,
                    inputTokens: 20,
                    outputTokens: 6,
                    totalTokens: 26,
                },
                latestDelta: {
                    durationMs: 200,
                    iterations: 2,
                    inputTokens: 20,
                    outputTokens: 2,
                    totalTokens: 22,
                },
            });
            expect(report.groups[0]?.recent[0]?.budgetPassed).toBeUndefined();
            expect(report.groups[0]?.recent[1]?.budgetPassed).toBe(false);
            expect(await Bun.file(join(root, "trend-report.json")).exists())
                .toBe(true);
        });
    });

    test("复制 Fixture、隔离 Settings，并用隐藏验证器检查真实修改", async () => {
        await withTempProject(async (root) => {
            const userSettings = join(root, "user-settings.json");
            await writeFile(
                userSettings,
                JSON.stringify({
                    sources: {
                        qwen: {
                            apiKeyEnv: "DASHSCOPE_API_KEY",
                            models: [
                                {id: "qwen-eval-model", label: "Eval Model"},
                            ],
                        },
                    },
                    models: {
                        primary: {source: "qwen", model: "qwen-eval-model"},
                        fast: {source: "qwen", model: "qwen-eval-model"},
                    },
                    hooks: {SessionStart: [{matcher: "*", hooks: []}]},
                    permissions: {deny: ["bash"]},
                })
            );
            const evalCase = getEvalCase("fix-failing-test");
            const prepared = await prepareEvalRun(evalCase, {
                evalRoot: root,
                settingsFile: userSettings,
                source: "qwen",
                model: "qwen-eval-model",
                envFileProvided: false,
                keep: "all",
            });
            const generatedSettings = JSON.parse(
                await readFile(
                    join(prepared.paths.pillarHome, "settings.json"),
                    "utf8"
                )
            ) as Record<string, unknown>;
            expect(generatedSettings.sources).toBeDefined();
            expect(generatedSettings.hooks).toBeUndefined();
            expect(generatedSettings.permissions).toEqual({
                defaultMode: "acceptEdits",
            });
            expect(prepared.verifierEnvironment.DASHSCOPE_API_KEY).toBeUndefined();

            const implementation = join(
                prepared.paths.workspace,
                "src",
                "counter.ts"
            );
            expect(
                await Bun.file(
                    join(
                        prepared.paths.workspace,
                        "tests",
                        "counter.test.ts"
                    )
                ).exists()
            ).toBe(true);
            const broken = await readFile(implementation, "utf8");
            await writeFile(
                implementation,
                broken.replace("increment: () => --current", "increment: () => ++current")
            );
            const workspaceState = await collectWorkspaceDiff(
                prepared.paths.workspace,
                prepared.baselineCommit,
                prepared.verifierEnvironment
            );
            expect(workspaceState.changedPaths).toEqual(["src/counter.ts"]);
            expect(workspaceState.diff).toContain("increment: () => ++current");
            const assertions = await runEvalVerification(
                evalCase,
                prepared.paths.workspace,
                workspaceState.changedPaths,
                prepared.verifierEnvironment
            );
            expect(assertions.every((assertion) => assertion.passed)).toBe(true);
            expect(
                assertions.find(
                    (assertion) =>
                        assertion.id === "command:hidden-counter-contract"
                )?.process?.stdout
            ).toContain("HIDDEN_COUNTER_OK");
        });
    });

    test("缺少 Provider Key 时离线生成可诊断失败报告并执行保留策略", async () => {
        await withTempProject(async (root) => {
            const userSettings = join(root, "user-settings.json");
            await writeFile(
                userSettings,
                JSON.stringify({
                    sources: {
                        qwen: {
                            apiKeyEnv:
                                "PILLAR_EVAL_TEST_DELIBERATELY_MISSING_PROVIDER_KEY",
                            models: [
                                {id: "qwen-eval-model", label: "Eval Model"},
                            ],
                        },
                    },
                    models: {
                        primary: {source: "qwen", model: "qwen-eval-model"},
                        fast: {source: "qwen", model: "qwen-eval-model"},
                    },
                })
            );
            const report = await runEvalCase({
                caseId: "fix-failing-test",
                evalRoot: root,
                settingsFile: userSettings,
                source: "qwen",
                model: "qwen-eval-model",
                keep: "none",
                timeoutMs: 5_000,
            });
            expect(report.passed).toBe(false);
            expect(report.failureKind).toBe("provider");
            expect(report.error?.message).toContain("缺少");
            expect(report.retained).toEqual({
                workspace: false,
                pillarHome: false,
            });
            expect(await Bun.file(report.paths.report).exists()).toBe(true);
            expect(await Bun.file(report.paths.transcript).exists()).toBe(true);
            expect(report.trend.updated).toBe(true);
            expect(await Bun.file(report.trend.reportPath).exists()).toBe(true);
        });
    });
});
