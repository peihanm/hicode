#!/usr/bin/env bun
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {parseArgs} from "node:util";
import {listEvalCases} from "./src/cases.js";
import {inspectEvalRun} from "./src/inspect.js";
import {
    createEvalLiveStatus,
    formatEvalHeartbeat,
    reduceEvalLiveStatus,
} from "./src/liveStatus.js";
import {runEvalCase} from "./src/runner.js";
import {runEvalSuite} from "./src/suite.js";
import {
    getEvalTrendReportPath,
    refreshEvalTrendReport,
} from "./src/trends.js";
import type {
    EvalBudget,
    EvalInspection,
    EvalKeepPolicy,
    EvalModelSource,
    EvalRunOptions,
    EvalSuiteOptions,
    EvalSuiteReport,
    EvalTrendReport,
} from "./src/types.js";

interface EvalCLIOptions extends EvalRunOptions {
    kind: "run";
    json: boolean;
    heartbeatMs: number;
    quiet: boolean;
}

interface EvalTrendCLIOptions {
    kind: "trend";
    evalRoot: string;
    json: boolean;
}

interface EvalSuiteCLIOptions extends EvalSuiteOptions {
    kind: "suite";
    json: boolean;
    heartbeatMs: number;
    quiet: boolean;
}

interface EvalInspectCLIOptions {
    kind: "inspect";
    evalRoot: string;
    runId: string;
    json: boolean;
}

type EvalCLICommand =
    | EvalCLIOptions
    | EvalTrendCLIOptions
    | EvalSuiteCLIOptions
    | EvalInspectCLIOptions;

async function main(): Promise<void> {
    const options = parseCLIOptions(process.argv.slice(2));
    if (!options) return;
    if (options.kind === "trend") {
        const trend = await refreshEvalTrendReport(options.evalRoot);
        printTrendReport(trend, options.json);
        return;
    }
    if (options.kind === "inspect") {
        const inspection = await inspectEvalRun(options.evalRoot, options.runId);
        printInspection(inspection, options.json);
        return;
    }
    if (options.kind === "suite") {
        await runSuiteCommand(options);
        return;
    }
    await runCaseCommand(options);
}

async function runCaseCommand(options: EvalCLIOptions): Promise<void> {
    let liveStatus = createEvalLiveStatus(Date.now());
    if (!options.quiet) {
        process.stderr.write(`${formatEvalHeartbeat(liveStatus, Date.now())}\n`);
    }
    const heartbeat = options.quiet ? undefined : setInterval(() => {
        process.stderr.write(`${formatEvalHeartbeat(liveStatus, Date.now())}\n`);
    }, options.heartbeatMs);
    heartbeat?.unref?.();
    let report;
    try {
        report = await runEvalCase(options, {
            onEvent: (event) => {
                liveStatus = reduceEvalLiveStatus(liveStatus, event);
            },
        });
    } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
    }
    if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        process.stdout.write(
            `${report.passed ? "PASS" : "FAIL"} ${report.caseId}\n` +
            `Run: ${report.paths.runDirectory}\n` +
            `Report: ${report.paths.report}\n` +
            `Trend: ${report.trend.reportPath}` +
                `${report.trend.updated ? "" : " (refresh failed)"}\n` +
            `Transcript: ${report.paths.transcript}\n` +
            `Workspace: ${report.retained.workspace ? report.paths.workspace : "not retained"}\n`
        );
        for (const assertion of report.assertions) {
            process.stdout.write(
                `${assertion.passed ? "  ✓" : "  ✗"} ${assertion.label}` +
                `${assertion.passed ? "" : ` (${assertion.actual ?? assertion.detail ?? "failed"})`}\n`
            );
        }
    }
    if (!report.passed) process.exitCode = 1;
}

async function runSuiteCommand(options: EvalSuiteCLIOptions): Promise<void> {
    let liveStatus = createEvalLiveStatus(Date.now());
    let label = "[suite]";
    const heartbeat = options.quiet ? undefined : setInterval(() => {
        process.stderr.write(
            `${label} ${formatEvalHeartbeat(liveStatus, Date.now())}\n`
        );
    }, options.heartbeatMs);
    heartbeat?.unref?.();
    let report: EvalSuiteReport;
    try {
        report = await runEvalSuite(options, {
            onCaseStarted: (context) => {
                label = `[suite ${context.index}/${context.total} ${context.caseId}]`;
                liveStatus = createEvalLiveStatus(Date.now());
                if (!options.quiet) {
                    process.stderr.write(
                        `${label} ${formatEvalHeartbeat(liveStatus, Date.now())}\n`
                    );
                }
            },
            onEvent: (context) => {
                liveStatus = reduceEvalLiveStatus(liveStatus, context.event);
            },
            onCaseCompleted: (entry) => {
                if (!options.quiet) {
                    process.stderr.write(
                        `${label} ${entry.passed ? "PASS" : "FAIL"}` +
                        `${entry.runId ? ` | run ${entry.runId}` : ""}\n`
                    );
                }
            },
        });
    } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
    }
    printSuiteReport(report, options.json);
    if (!report.passed) process.exitCode = 1;
}

function parseCLIOptions(args: string[]): EvalCLICommand | undefined {
    const parsed = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        options: {
            help: {type: "boolean", short: "h"},
            list: {type: "boolean"},
            trend: {type: "boolean"},
            suite: {type: "boolean"},
            inspect: {type: "string"},
            case: {type: "string"},
            cases: {type: "string"},
            "eval-root": {type: "string"},
            "settings-file": {type: "string"},
            "env-file": {type: "string"},
            source: {type: "string"},
            model: {type: "string"},
            keep: {type: "string"},
            "max-iterations": {type: "string"},
            "timeout-ms": {type: "string"},
            "budget-iterations": {type: "string"},
            "budget-input-tokens": {type: "string"},
            "budget-output-tokens": {type: "string"},
            "budget-total-tokens": {type: "string"},
            "budget-duration-ms": {type: "string"},
            "heartbeat-ms": {type: "string"},
            quiet: {type: "boolean"},
            json: {type: "boolean"},
        },
    });
    if (parsed.values.help) {
        printHelp();
        return undefined;
    }
    if (parsed.values.list) {
        if (
            parsed.values.trend || parsed.values.suite ||
            parsed.values.inspect || parsed.values.case || parsed.values.cases
        ) {
            throw new Error("--list 不能与其他命令同时使用");
        }
        for (const evalCase of listEvalCases()) {
            process.stdout.write(`${evalCase.id}\t${evalCase.description}\n`);
        }
        return undefined;
    }
    const evalRoot = resolve(
        parsed.values["eval-root"] ?? join(homedir(), ".pillar-evals")
    );
    if (parsed.values.trend) {
        assertNoOtherCommand(parsed.values, "--trend");
        return {
            kind: "trend",
            evalRoot,
            json: parsed.values.json ?? false,
        };
    }
    if (parsed.values.inspect) {
        assertNoOtherCommand(parsed.values, "--inspect");
        return {
            kind: "inspect",
            evalRoot,
            runId: requireText(parsed.values.inspect, "--inspect"),
            json: parsed.values.json ?? false,
        };
    }
    const common = parseCommonRunOptions(parsed.values, evalRoot);
    if (parsed.values.suite) {
        if (parsed.values.case) {
            throw new Error("--suite 使用 --cases，不能同时提供 --case");
        }
        return {
            kind: "suite",
            ...common,
            caseIds: parseCaseIds(parsed.values.cases),
        };
    }
    if (parsed.values.cases) {
        throw new Error("--cases 只能与 --suite 一起使用");
    }
    return {
        kind: "run",
        ...common,
        caseId: requireText(parsed.values.case, "--case"),
    };
}

function parseCommonRunOptions(
    values: Readonly<Record<string, string | boolean | undefined>>,
    evalRoot: string
): Omit<EvalCLIOptions, "kind" | "caseId"> {
    const defaultSettings = join(homedir(), ".pillar", "settings.json");
    return {
        evalRoot,
        settingsFile: textOption(values["settings-file"])
            ? resolve(String(values["settings-file"]))
            : existsSync(defaultSettings)
                ? defaultSettings
                : undefined,
        envFile: textOption(values["env-file"])
            ? resolve(String(values["env-file"]))
            : undefined,
        source: parseSource(textOption(values.source)),
        model: optionalText(textOption(values.model), "--model"),
        keep: parseKeepPolicy(textOption(values.keep)),
        maxIterations: optionalInteger(
            textOption(values["max-iterations"]),
            "--max-iterations",
            1,
            100
        ),
        timeoutMs: optionalInteger(
            textOption(values["timeout-ms"]),
            "--timeout-ms",
            1_000,
            3_600_000
        ),
        budget: parseBudget(values),
        heartbeatMs: optionalInteger(
            textOption(values["heartbeat-ms"]),
            "--heartbeat-ms",
            1_000,
            60_000
        ) ?? 15_000,
        quiet: values.quiet === true,
        json: values.json === true,
    };
}

function printHelp(): void {
    process.stdout.write(`Pillar SDK Eval Harness

Usage:
  bun run eval -- --case <id> [options]
  bun run eval:suite -- --cases <id,id,...> [options]
  bun run eval -- --inspect <run-id> [--json]
  bun run eval -- --list
  bun run eval -- --trend [--eval-root <path>] [--json]

Options:
      --case <id>             Eval Case id
      --suite                 Run multiple Cases sequentially
      --cases <ids>           Comma-separated Case ids, or all
      --inspect <run-id>      Diagnose an existing Run without calling Provider
      --eval-root <path>      Run artifacts root (default: ~/.pillar-evals)
      --settings-file <path>  User Settings catalog (default: ~/.pillar/settings.json when present)
      --env-file <path>       Explicit Provider env file; never copied into artifacts
      --source <source>       glm | qwen | deepseek
      --model <model>         Primary and fast model override
      --keep <policy>         all | failed | none (default: all)
      --max-iterations <n>    1..100 override
      --timeout-ms <ms>       1000..3600000 override
      --budget-iterations <n> Soft iteration budget; exceeding it fails the Case
      --budget-input-tokens <n>
      --budget-output-tokens <n>
      --budget-total-tokens <n>
      --budget-duration-ms <n> Turn duration budget in milliseconds
      --heartbeat-ms <n>      Live status interval, 1000..60000 (default: 15000)
      --quiet                 Disable live status; reports and SDK events remain
      --trend                 Rebuild historical trend-report.json from Run reports
      --json                  Print the full Run, Suite, Trend, or Inspection JSON
      --list                  List available Cases
  -h, --help                  Show help

The verifier gets a secret-filtered environment. Full workspaces and Pillar
sessions are retained by default so another development agent can inspect them.
`);
}

function printSuiteReport(report: EvalSuiteReport, json: boolean): void {
    if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }
    process.stdout.write(
        `${report.passed ? "PASS" : "FAIL"} suite ${report.suiteId}\n` +
        `Cases: ${report.totals.passedCount}/${report.totals.caseCount} passed\n` +
        `Duration: ${report.durationMs}ms\n` +
        `Report: ${report.paths.report}\n`
    );
    for (const entry of report.cases) {
        process.stdout.write(
            `  ${entry.passed ? "✓" : "✗"} ${entry.caseId}` +
            `${entry.failureKind ? ` [${entry.failureKind}]` : ""}` +
            `${entry.runId ? ` — ${entry.runId}` : ""}` +
            `${entry.error ? ` (${entry.error.message})` : ""}\n`
        );
    }
    const usage = report.totals.usage;
    if (usage) {
        process.stdout.write(
            `Usage: ${usage.inputTokens} input / ` +
            `${usage.outputTokens ?? "unknown"} output / ` +
            `${usage.totalTokens ?? "unknown"} total` +
            `${usage.estimated ? " (partial/estimated)" : ""}\n`
        );
    }
}

function printInspection(inspection: EvalInspection, json: boolean): void {
    if (json) {
        process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
        return;
    }
    process.stdout.write(
        `${inspection.status.toUpperCase()} ${inspection.runId}` +
        `${inspection.caseId ? ` | ${inspection.caseId}` : ""}` +
        `${inspection.failureKind ? ` | ${inspection.failureKind}` : ""}\n` +
        `Summary: ${inspection.summary}\n`
    );
    if (inspection.turn) {
        process.stdout.write(
            `Turn: ${inspection.turn.stopReason ?? "unknown"}` +
            `${inspection.turn.abortReason ? ` (${inspection.turn.abortReason})` : ""}` +
            ` | ${formatMetric(inspection.turn.iterations)} iterations` +
            ` | ${formatMetric(inspection.turn.durationMs)}ms\n`
        );
    }
    if (inspection.usage) {
        process.stdout.write(
            `Usage: ${inspection.usage.inputTokens} input / ` +
            `${inspection.usage.outputTokens ?? "unknown"} output / ` +
            `${inspection.usage.totalTokens ?? "unknown"} total\n`
        );
    }
    if (inspection.lastProgress) {
        process.stdout.write(
            `Last model signal: ${inspection.lastProgress.phase}` +
            `${inspection.lastProgress.toolName ? ` (${inspection.lastProgress.toolName})` : ""}` +
            `${inspection.lastProgress.estimatedOutputTokens === undefined
                ? ""
                : ` | ~${inspection.lastProgress.estimatedOutputTokens} output tokens`}\n`
        );
    }
    if (inspection.lastEvent) {
        process.stdout.write(
            `Last event: #${inspection.lastEvent.sequence} ${inspection.lastEvent.type}` +
            ` | ${inspection.lastEvent.ageMs}ms ago\n`
        );
    }
    process.stdout.write(
        `Interactions: ${inspection.interactions.completed}/${inspection.interactions.started} completed` +
        ` | pending ${inspection.interactions.pending}` +
        ` | total wait ${inspection.interactions.totalWaitMs}ms` +
        ` | max wait ${inspection.interactions.maxWaitMs}ms\n`
    );
    if (inspection.changedPaths.length > 0) {
        process.stdout.write(`Changed: ${inspection.changedPaths.join(", ")}\n`);
    }
    if (inspection.failedAssertions.length > 0) {
        process.stdout.write("Failed assertions:\n");
        for (const assertion of inspection.failedAssertions) {
            process.stdout.write(
                `  - ${assertion.label}: ` +
                `${assertion.actual ?? assertion.detail ?? "failed"}` +
                `${assertion.exitCode === undefined ? "" : ` (exit ${assertion.exitCode})`}\n`
            );
            if (assertion.stderrPreview) {
                process.stdout.write(`    ${indent(assertion.stderrPreview)}\n`);
            }
        }
    }
    if (inspection.failedTools.length > 0) {
        process.stdout.write("Failed tools:\n");
        for (const tool of inspection.failedTools) {
            process.stdout.write(
                `  - ${tool.name}: ${tool.outcome ?? tool.status}` +
                `${tool.resultPreview ? ` — ${tool.resultPreview}` : ""}\n`
            );
        }
    }
    if (inspection.finalResponsePreview) {
        process.stdout.write(
            `Final response:\n  ${indent(inspection.finalResponsePreview)}\n`
        );
    }
    if (inspection.issues.length > 0) {
        process.stdout.write(`Issues: ${inspection.issues.join("; ")}\n`);
    }
    process.stdout.write(
        `Report: ${inspection.paths.report}\n` +
        `Workspace: ${inspection.paths.workspace}\n`
    );
}

function parseBudget(
    values: Readonly<Record<string, string | boolean | undefined>>
): EvalBudget | undefined {
    const budget: EvalBudget = {
        maxIterations: optionalInteger(
            textOption(values["budget-iterations"]),
            "--budget-iterations",
            1,
            100
        ),
        maxInputTokens: optionalInteger(
            textOption(values["budget-input-tokens"]),
            "--budget-input-tokens",
            1,
            2_000_000_000
        ),
        maxOutputTokens: optionalInteger(
            textOption(values["budget-output-tokens"]),
            "--budget-output-tokens",
            1,
            2_000_000_000
        ),
        maxTotalTokens: optionalInteger(
            textOption(values["budget-total-tokens"]),
            "--budget-total-tokens",
            1,
            2_000_000_000
        ),
        maxDurationMs: optionalInteger(
            textOption(values["budget-duration-ms"]),
            "--budget-duration-ms",
            1,
            3_600_000
        ),
    };
    return Object.values(budget).some((value) => value !== undefined)
        ? budget
        : undefined;
}

function textOption(value: string | boolean | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function parseCaseIds(value: string | undefined): string[] {
    const text = requireText(value, "--cases");
    if (text === "all") return listEvalCases().map((evalCase) => evalCase.id);
    return text.split(",").map((caseId) => caseId.trim());
}

function assertNoOtherCommand(
    values: Readonly<Record<string, string | boolean | undefined>>,
    current: "--trend" | "--inspect"
): void {
    const conflicts = current === "--trend"
        ? [values.inspect, values.suite, values.case, values.cases]
        : [values.trend, values.suite, values.case, values.cases];
    if (conflicts.some(Boolean)) {
        throw new Error(`${current} 不能与其他命令同时使用`);
    }
}

function indent(value: string): string {
    return value.replace(/\n/g, "\n    ");
}

function printTrendReport(report: EvalTrendReport, json: boolean): void {
    if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }
    process.stdout.write(
        `Trend: ${getEvalTrendReportPath(report.evalRoot)}\n` +
        `Runs: ${report.runCount}, skipped: ${report.skippedReportCount}\n`
    );
    for (const group of report.groups) {
        const average = group.averages;
        process.stdout.write(
            `${group.caseId} | ${group.source ?? "unknown"}/${group.model ?? "unknown"}` +
            ` | pass ${(group.passRate * 100).toFixed(1)}% (${group.passedCount}/${group.runCount})` +
            ` | avg iter ${formatMetric(average.iterations)}` +
            ` | avg tokens ${formatMetric(average.totalTokens)}` +
            ` | avg ${formatMetric(average.durationMs)}ms\n`
        );
    }
    if (report.issues.length > 0) {
        process.stdout.write(`Warnings: ${report.issues.length}（详见趋势报告）\n`);
    }
}

function formatMetric(value: number | undefined): string {
    return value === undefined ? "n/a" : String(value);
}

function parseSource(value: string | undefined): EvalModelSource | undefined {
    if (value === undefined) return undefined;
    if (value === "glm" || value === "qwen" || value === "deepseek") {
        return value;
    }
    throw new Error("--source 必须是 glm | qwen | deepseek");
}

function parseKeepPolicy(value: string | undefined): EvalKeepPolicy {
    if (value === undefined || value === "all") return "all";
    if (value === "failed" || value === "none") return value;
    throw new Error("--keep 必须是 all | failed | none");
}

function requireText(value: string | undefined, name: string): string {
    const normalized = value?.trim();
    if (!normalized) throw new Error(`${name} 需要非空值`);
    return normalized;
}

function optionalText(
    value: string | undefined,
    name: string
): string | undefined {
    return value === undefined ? undefined : requireText(value, name);
}

function optionalInteger(
    value: string | undefined,
    name: string,
    min: number,
    max: number
): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
    }
    return parsed;
}

main().catch((error: unknown) => {
    process.stderr.write(
        `[eval_error] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
});
