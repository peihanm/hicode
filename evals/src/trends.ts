import {lstat, readFile, readdir} from "node:fs/promises";
import {join, resolve} from "node:path";
import {withFileLock} from "../../src/persistence/index.js";
import {writeJsonAtomic} from "./artifacts.js";
import type {
    EvalFailureKind,
    EvalModelSource,
    EvalTrendGroup,
    EvalTrendIssue,
    EvalTrendMetrics,
    EvalTrendPoint,
    EvalTrendReport,
} from "./types.js";

const MAX_REPORTS = 2_000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_ISSUES = 50;
const RECENT_POINTS = 20;

interface ParsedTrendRun {
    caseId: string;
    source?: EvalModelSource;
    model?: string;
    point: EvalTrendPoint;
}

export async function refreshEvalTrendReport(
    evalRoot: string
): Promise<EvalTrendReport> {
    const reportPath = getEvalTrendReportPath(evalRoot);
    return withFileLock(`${reportPath}.lock`, async () => {
        const report = await buildEvalTrendReport(evalRoot);
        await writeJsonAtomic(reportPath, report);
        return report;
    });
}

export async function buildEvalTrendReport(
    evalRoot: string
): Promise<EvalTrendReport> {
    const normalizedRoot = resolve(evalRoot);
    const runsRoot = join(normalizedRoot, "runs");
    const issues: EvalTrendIssue[] = [];
    let entries;
    try {
        entries = await readdir(runsRoot, {withFileTypes: true});
    } catch (error) {
        if (isMissingPath(error)) {
            return createTrendReport(normalizedRoot, [], issues, 0);
        }
        throw error;
    }
    const runDirectories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    const selected = runDirectories.slice(-MAX_REPORTS);
    const skippedByLimit = runDirectories.length - selected.length;
    if (skippedByLimit > 0) {
        addIssue(issues, runsRoot, `超过 ${MAX_REPORTS} 个 Run，跳过最早 ${skippedByLimit} 个`);
    }
    const runs: ParsedTrendRun[] = [];
    let skippedReportCount = skippedByLimit;
    for (const directory of selected) {
        const reportPath = join(runsRoot, directory, "report.json");
        try {
            const reportStat = await lstat(reportPath);
            if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
                throw new Error("report.json 必须是普通文件且不能是 Symlink");
            }
            if (reportStat.size > MAX_REPORT_BYTES) {
                throw new Error(`report.json 超过 ${MAX_REPORT_BYTES} bytes`);
            }
            const parsed = parseTrendRun(
                JSON.parse(await readFile(reportPath, "utf8")) as unknown
            );
            runs.push(parsed);
        } catch (error) {
            skippedReportCount += 1;
            addIssue(
                issues,
                reportPath,
                error instanceof Error ? error.message : String(error)
            );
        }
    }
    return createTrendReport(
        normalizedRoot,
        runs,
        issues,
        skippedReportCount
    );
}

export function getEvalTrendReportPath(evalRoot: string): string {
    return join(resolve(evalRoot), "trend-report.json");
}

function createTrendReport(
    evalRoot: string,
    runs: readonly ParsedTrendRun[],
    issues: EvalTrendIssue[],
    skippedReportCount: number
): EvalTrendReport {
    const groups = new Map<string, ParsedTrendRun[]>();
    for (const run of runs) {
        const key = `${run.caseId}\0${run.source ?? ""}\0${run.model ?? ""}`;
        const group = groups.get(key) ?? [];
        group.push(run);
        groups.set(key, group);
    }
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        evalRoot,
        runCount: runs.length,
        skippedReportCount,
        issues,
        groups: [...groups.values()]
            .map(createTrendGroup)
            .sort(compareTrendGroups),
    };
}

function createTrendGroup(runs: ParsedTrendRun[]): EvalTrendGroup {
    runs.sort((left, right) =>
        left.point.finishedAt.localeCompare(right.point.finishedAt)
    );
    const first = runs[0];
    if (!first) throw new Error("趋势分组不能为空");
    const recent = runs.slice(-RECENT_POINTS).map((run) => run.point);
    const latest = recent.at(-1);
    if (!latest) throw new Error("趋势分组缺少最新 Run");
    const previous = recent.at(-2);
    const passedCount = runs.filter((run) => run.point.passed).length;
    return {
        caseId: first.caseId,
        source: first.source,
        model: first.model,
        runCount: runs.length,
        passedCount,
        passRate: round(passedCount / runs.length, 4),
        latestFinishedAt: latest.finishedAt,
        averages: averageMetrics(runs.map((run) => run.point)),
        latestDelta: previous ? subtractMetrics(latest, previous) : {},
        recent,
    };
}

function parseTrendRun(value: unknown): ParsedTrendRun {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error("不支持的 Eval report schema");
    }
    const runId = requireText(value.runId, "runId");
    const caseId = requireText(value.caseId, "caseId");
    const finishedAt = requireTimestamp(value.finishedAt, "finishedAt");
    if (typeof value.passed !== "boolean") {
        throw new Error("passed 必须是 boolean");
    }
    const result = isRecord(value.result) ? value.result : undefined;
    const usage = result && isRecord(result.usage) ? result.usage : undefined;
    const budget = isRecord(value.budget) ? value.budget : undefined;
    return {
        caseId,
        source: parseSource(value.source),
        model: optionalText(value.model),
        point: {
            runId,
            finishedAt,
            passed: value.passed,
            failureKind: parseFailureKind(value.failureKind),
            budgetPassed:
                typeof budget?.passed === "boolean" ? budget.passed : undefined,
            durationMs: optionalMetric(value.durationMs, "durationMs"),
            iterations: optionalMetric(result?.iterations, "iterations"),
            inputTokens: optionalMetric(usage?.inputTokens, "inputTokens"),
            outputTokens: optionalMetric(usage?.outputTokens, "outputTokens"),
            totalTokens: optionalMetric(usage?.totalTokens, "totalTokens"),
        },
    };
}

function averageMetrics(points: readonly EvalTrendMetrics[]): EvalTrendMetrics {
    const result: EvalTrendMetrics = {};
    for (const field of metricFields()) {
        const values = points
            .map((point) => point[field])
            .filter((value): value is number => value !== undefined);
        if (values.length > 0) {
            result[field] = Math.round(
                values.reduce((sum, value) => sum + value, 0) / values.length
            );
        }
    }
    return result;
}

function subtractMetrics(
    latest: EvalTrendMetrics,
    previous: EvalTrendMetrics
): EvalTrendMetrics {
    const result: EvalTrendMetrics = {};
    for (const field of metricFields()) {
        const latestValue = latest[field];
        const previousValue = previous[field];
        if (latestValue !== undefined && previousValue !== undefined) {
            result[field] = latestValue - previousValue;
        }
    }
    return result;
}

function metricFields(): readonly (keyof EvalTrendMetrics)[] {
    return [
        "durationMs",
        "iterations",
        "inputTokens",
        "outputTokens",
        "totalTokens",
    ];
}

function parseSource(value: unknown): EvalModelSource | undefined {
    if (value === undefined) return undefined;
    if (value === "glm" || value === "qwen" || value === "deepseek") {
        return value;
    }
    throw new Error("source 非法");
}

function parseFailureKind(value: unknown): EvalFailureKind | undefined {
    if (value === undefined) return undefined;
    if (
        value === "agent" ||
        value === "budget" ||
        value === "provider" ||
        value === "runtime" ||
        value === "verifier"
    ) {
        return value;
    }
    throw new Error("failureKind 非法");
}

function optionalMetric(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${field} 必须是非负有限数字`);
    }
    return value;
}

function requireText(value: unknown, field: string): string {
    const text = optionalText(value);
    if (!text) throw new Error(`${field} 必须是非空字符串`);
    return text;
}

function optionalText(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.length > 1_000) {
        throw new Error("字符串字段非法");
    }
    return value;
}

function requireTimestamp(value: unknown, field: string): string {
    const timestamp = requireText(value, field);
    if (!Number.isFinite(Date.parse(timestamp))) {
        throw new Error(`${field} 不是合法时间`);
    }
    return timestamp;
}

function compareTrendGroups(left: EvalTrendGroup, right: EvalTrendGroup): number {
    return left.caseId.localeCompare(right.caseId) ||
        (left.source ?? "").localeCompare(right.source ?? "") ||
        (left.model ?? "").localeCompare(right.model ?? "");
}

function addIssue(
    issues: EvalTrendIssue[],
    reportPath: string,
    message: string
): void {
    if (issues.length >= MAX_ISSUES) return;
    issues.push({reportPath, message: message.slice(0, 1_000)});
}

function round(value: number, digits: number): number {
    const multiplier = 10 ** digits;
    return Math.round(value * multiplier) / multiplier;
}

function isMissingPath(error: unknown): boolean {
    return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
