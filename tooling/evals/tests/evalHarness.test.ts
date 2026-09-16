import {describe, expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
    collectWorkspaceDiff,
    prepareEvalRun,
} from "../src/artifacts.js";
import {getEvalCase, listEvalCases} from "../src/cases.js";
import {
    evaluateEvalBudget,
    mergeEvalBudget,
} from "../src/budget.js";
import {runEvalCase} from "../src/runner.js";
import {classifyEvalFailure} from "../src/failure.js";
import {inspectEvalRun} from "../src/inspect.js";
import {
    createEvalLiveStatus,
    formatEvalHeartbeat,
    reduceEvalLiveStatus,
} from "../src/liveStatus.js";
import {refreshEvalTrendReport} from "../src/trends.js";
import {runEvalVerification} from "../src/verifier.js";
import {runEvalSuite, validateCaseIds} from "../src/suite.js";

async function withTempDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "hicode-eval-test-"));
    try {
        return await run(root);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
}

describe("SDK Eval Harness", () => {
    test("公开首批 Case 并拒绝未知 Case", () => {
        expect(listEvalCases().map((item) => item.id)).toEqual([
            "fix-failing-test",
            "create-and-run-code",
            "leetcode-web",
        ]);
        expect(() => getEvalCase("missing")).toThrow("未知 Eval Case");
    });

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
        await withTempDirectory(async (root) => {
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
        await withTempDirectory(async (root) => {
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
                    join(prepared.paths.hicodeHome, "settings.json"),
                    "utf8"
                )
            ) as Record<string, unknown>;
            expect(generatedSettings.sources).toBeDefined();
            expect(generatedSettings.hooks).toBeUndefined();
            expect(generatedSettings.permissions).toEqual({
                defaultMode: "ask",
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
        await withTempDirectory(async (root) => {
            const userSettings = join(root, "user-settings.json");
            await writeFile(
                userSettings,
                JSON.stringify({
                    sources: {
                        qwen: {
                            apiKeyEnv:
                                "HICODE_EVAL_TEST_DELIBERATELY_MISSING_PROVIDER_KEY",
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
            expect(report.error?.message).toContain("Missing");
            expect(report.retained).toEqual({
                workspace: false,
                hicodeHome: false,
            });
            expect(await Bun.file(report.paths.report).exists()).toBe(true);
            expect(await Bun.file(report.paths.transcript).exists()).toBe(true);
            expect(report.trend.updated).toBe(true);
            expect(await Bun.file(report.trend.reportPath).exists()).toBe(true);
        });
    });

    test("Suite 顺序运行多个 Case 并写入独立汇总报告", async () => {
        await withTempDirectory(async (root) => {
            const userSettings = join(root, "suite-settings.json");
            await writeFile(
                userSettings,
                JSON.stringify({
                    sources: {
                        qwen: {
                            apiKeyEnv:
                                "HICODE_EVAL_SUITE_DELIBERATELY_MISSING_KEY",
                            models: [
                                {id: "qwen-suite-model", label: "Suite Model"},
                            ],
                        },
                    },
                    models: {
                        primary: {source: "qwen", model: "qwen-suite-model"},
                        fast: {source: "qwen", model: "qwen-suite-model"},
                    },
                })
            );
            const report = await runEvalSuite({
                caseIds: ["fix-failing-test", "create-and-run-code"],
                evalRoot: root,
                settingsFile: userSettings,
                source: "qwen",
                model: "qwen-suite-model",
                keep: "none",
                timeoutMs: 5_000,
            });
            expect(report.passed).toBe(false);
            expect(report.requestedCaseIds).toEqual([
                "fix-failing-test",
                "create-and-run-code",
            ]);
            expect(report.totals).toMatchObject({
                caseCount: 2,
                passedCount: 0,
                failedCount: 2,
                completedRunCount: 2,
                failures: {provider: 2},
            });
            expect(report.cases.map((entry) => entry.failureKind)).toEqual([
                "provider",
                "provider",
            ]);
            expect(await Bun.file(report.paths.report).exists()).toBe(true);
            const persisted = JSON.parse(
                await readFile(report.paths.report, "utf8")
            ) as {suiteId?: string};
            expect(persisted.suiteId).toBe(report.suiteId);
            expect(() => validateCaseIds([
                "fix-failing-test",
                "fix-failing-test",
            ])).toThrow("不能重复");
            expect(() => validateCaseIds(["missing"])).toThrow("未知 Eval Case");

            const cliRoot = join(root, "cli-suite");
            const cli = Bun.spawn([
                process.execPath,
                "run",
                "eval:suite",
                "--",
                "--cases",
                "fix-failing-test",
                "--eval-root",
                cliRoot,
                "--settings-file",
                userSettings,
                "--source",
                "qwen",
                "--model",
                "qwen-suite-model",
                "--keep",
                "none",
                "--quiet",
                "--json",
            ], {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [exitCode, stdout] = await Promise.all([
                cli.exited,
                new Response(cli.stdout).text(),
            ]);
            expect(exitCode).toBe(1);
            const cliReport = JSON.parse(stdout) as {
                requestedCaseIds?: string[];
                totals?: {caseCount?: number};
            };
            expect(cliReport.requestedCaseIds).toEqual(["fix-failing-test"]);
            expect(cliReport.totals?.caseCount).toBe(1);
        });
    });

    test("Inspect 从不可信 Run 产物提取失败、活性与交互等待", async () => {
        await withTempDirectory(async (root) => {
            const runId = "run-inspect";
            const runDirectory = join(root, "runs", runId);
            await mkdir(runDirectory, {recursive: true});
            await Promise.all([
                writeFile(join(runDirectory, "manifest.json"), JSON.stringify({
                    schemaVersion: 1,
                    runId,
                    caseId: "leetcode-web",
                    status: "failed",
                })),
                writeFile(join(runDirectory, "report.json"), JSON.stringify({
                    schemaVersion: 1,
                    runId,
                    caseId: "leetcode-web",
                    passed: false,
                    failureKind: "agent",
                    result: {
                        stopReason: "completed",
                        iterations: 4,
                        durationMs: 4_000,
                        usage: {
                            inputTokens: 100,
                            outputTokens: 20,
                            totalTokens: 120,
                            estimated: false,
                        },
                    },
                    assertions: [{
                        id: "command:hidden",
                        label: "隐藏契约通过",
                        passed: false,
                        actual: "exit 1",
                        process: {exitCode: 1, stderr: "contract failed"},
                    }],
                    changedPaths: ["server.ts", "public/app.js"],
                })),
                writeFile(join(runDirectory, "transcript.json"), JSON.stringify({
                    schemaVersion: 1,
                    finalResponse: "实现完成，但隐藏契约没有通过。",
                })),
                writeFile(join(runDirectory, "sdk-events.jsonl"), [
                    eventLine(1, "turn.progress", 1_000, {
                        phase: "reasoning",
                        estimatedOutputTokens: 256,
                    }),
                    eventLine(2, "item.started", 2_000, {
                        item: interactionItem("interaction-1", "in_progress"),
                    }),
                    eventLine(3, "item.completed", 2_007, {
                        item: interactionItem("interaction-1", "completed"),
                    }),
                    eventLine(4, "item.completed", 3_000, {
                        item: {
                            id: "tool-1",
                            type: "tool_call",
                            status: "failed",
                            name: "bash",
                            outcome: "failed",
                            resultPreview: "exit 1",
                        },
                    }),
                    eventLine(5, "turn.completed", 4_000),
                    "",
                ].join("\n")),
            ]);

            const inspection = await inspectEvalRun(root, runId, 5_000);
            expect(inspection).toMatchObject({
                runId,
                caseId: "leetcode-web",
                status: "failed",
                passed: false,
                failureKind: "agent",
                interactions: {
                    started: 1,
                    completed: 1,
                    pending: 0,
                    totalWaitMs: 7,
                    maxWaitMs: 7,
                },
                lastEvent: {
                    type: "turn.completed",
                    sequence: 5,
                    ageMs: 1_000,
                },
                lastProgress: {
                    phase: "reasoning",
                    estimatedOutputTokens: 256,
                },
                changedPaths: ["server.ts", "public/app.js"],
            });
            expect(inspection.summary).toContain("隐藏契约通过");
            expect(inspection.failedAssertions[0]?.stderrPreview)
                .toBe("contract failed");
            expect(inspection.failedTools).toEqual([{
                name: "bash",
                status: "failed",
                outcome: "failed",
                resultPreview: "exit 1",
            }]);
            expect(inspection.finalResponsePreview).toContain("实现完成");
            await expect(inspectEvalRun(root, "../escape")).rejects
                .toThrow("Run id 非法");
        });
    });

    test("Inspect 能识别没有最终 report 的中断 Run", async () => {
        await withTempDirectory(async (root) => {
            const runId = "run-partial";
            const runDirectory = join(root, "runs", runId);
            await mkdir(runDirectory, {recursive: true});
            await writeFile(join(runDirectory, "manifest.json"), JSON.stringify({
                schemaVersion: 1,
                runId,
                caseId: "leetcode-web",
                status: "running",
            }));
            await writeFile(
                join(runDirectory, "sdk-events.jsonl"),
                `${eventLine(9, "turn.progress", 1_000, {
                    phase: "tool_input",
                    toolName: "write_file",
                    estimatedOutputTokens: 512,
                })}\n`
            );
            const inspection = await inspectEvalRun(root, runId, 10_000);
            expect(inspection.status).toBe("running");
            expect(inspection.summary).toContain("可能仍在运行或被外部中断");
            expect(inspection.lastProgress).toMatchObject({
                phase: "tool_input",
                toolName: "write_file",
            });
            expect(inspection.issues).toContain("缺少最终 report.json");
        });
    });
});

function eventLine(
    sequence: number,
    type: string,
    emittedMs: number,
    extra: Record<string, unknown> = {}
): string {
    return JSON.stringify({
        protocolVersion: 1,
        sequence,
        threadId: "thread",
        turnId: "turn",
        emittedAt: new Date(emittedMs).toISOString(),
        type,
        ...extra,
    });
}

function interactionItem(
    requestId: string,
    status: "in_progress" | "completed"
): Record<string, unknown> {
    return {
        id: `interaction:${requestId}`,
        type: "interaction",
        status,
        request: {
            requestId,
            kind: "permission",
            toolName: "bash",
            message: "run",
            input: {command: "true"},
        },
    };
}
