import {randomUUID} from "node:crypto";
import {mkdir} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";
import {writeJsonAtomic} from "./artifacts.js";
import {getEvalCase} from "./cases.js";
import {runEvalCase} from "./runner.js";
import type {
    EvalFailureKind,
    EvalReport,
    EvalSuiteCaseResult,
    EvalSuiteObserver,
    EvalSuiteOptions,
    EvalSuiteReport,
} from "./types.js";

const MAX_SUITE_CASES = 50;

export async function runEvalSuite(
    options: EvalSuiteOptions,
    observer: EvalSuiteObserver = {}
): Promise<EvalSuiteReport> {
    const caseIds = validateCaseIds(options.caseIds);
    if (!isAbsolute(options.evalRoot)) {
        throw new Error("Eval Root 必须是绝对路径");
    }
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    const paths = await createSuitePaths(options.evalRoot);
    const entries: EvalSuiteCaseResult[] = [];

    for (const [index, caseId] of caseIds.entries()) {
        const context = {caseId, index: index + 1, total: caseIds.length};
        notify(() => observer.onCaseStarted?.(context));
        let entry: EvalSuiteCaseResult;
        try {
            const report = await runEvalCase(
                {
                    caseId,
                    evalRoot: options.evalRoot,
                    settingsFile: options.settingsFile,
                    envFile: options.envFile,
                    source: options.source,
                    model: options.model,
                    keep: options.keep,
                    maxIterations: options.maxIterations,
                    timeoutMs: options.timeoutMs,
                    budget: options.budget,
                },
                {
                    onEvent: (event) => notify(() => observer.onEvent?.({
                        ...context,
                        event,
                    })),
                }
            );
            entry = summarizeCaseReport(report);
        } catch (error) {
            entry = {
                caseId,
                passed: false,
                failureKind: "runtime",
                error: {
                    code: "suite_case_runtime_error",
                    message: boundedMessage(error),
                },
            };
        }
        entries.push(entry);
        notify(() => observer.onCaseCompleted?.(entry));
    }

    const report = createSuiteReport({
        suiteId: paths.suiteId,
        paths,
        startedAt,
        durationMs: Math.round(performance.now() - startedMs),
        caseIds,
        source: options.source,
        model: options.model,
        entries,
    });
    await writeJsonAtomic(paths.report, report);
    return report;
}

export function validateCaseIds(caseIds: readonly string[]): string[] {
    if (caseIds.length === 0) {
        throw new Error("Suite 至少需要一个 Eval Case");
    }
    if (caseIds.length > MAX_SUITE_CASES) {
        throw new Error(`Suite 最多包含 ${MAX_SUITE_CASES} 个 Case`);
    }
    const normalized = caseIds.map((caseId) => caseId.trim());
    if (normalized.some((caseId) => caseId.length === 0)) {
        throw new Error("Suite Case id 不能为空");
    }
    const duplicates = normalized.filter(
        (caseId, index) => normalized.indexOf(caseId) !== index
    );
    if (duplicates.length > 0) {
        throw new Error(`Suite Case 不能重复: ${[...new Set(duplicates)].join(", ")}`);
    }
    for (const caseId of normalized) getEvalCase(caseId);
    return normalized;
}

function summarizeCaseReport(report: EvalReport): EvalSuiteCaseResult {
    return {
        caseId: report.caseId,
        passed: report.passed,
        source: report.source,
        model: report.model,
        runId: report.runId,
        reportPath: report.paths.report,
        failureKind: report.failureKind,
        durationMs: report.durationMs,
        iterations: report.result?.iterations,
        usage: report.result?.usage ?? undefined,
        error: report.error,
    };
}

function createSuiteReport(input: {
    suiteId: string;
    paths: {suiteDirectory: string; report: string};
    startedAt: string;
    durationMs: number;
    caseIds: string[];
    source?: EvalSuiteOptions["source"];
    model?: string;
    entries: EvalSuiteCaseResult[];
}): EvalSuiteReport {
    const failures: Partial<Record<EvalFailureKind, number>> = {};
    for (const entry of input.entries) {
        if (entry.passed) continue;
        const kind = entry.failureKind ?? "runtime";
        failures[kind] = (failures[kind] ?? 0) + 1;
    }
    const usage = aggregateUsage(input.entries);
    const passedCount = input.entries.filter((entry) => entry.passed).length;
    return {
        schemaVersion: 1,
        suiteId: input.suiteId,
        passed: passedCount === input.entries.length,
        startedAt: input.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: input.durationMs,
        requestedCaseIds: input.caseIds,
        source: input.source,
        model: input.model,
        totals: {
            caseCount: input.entries.length,
            passedCount,
            failedCount: input.entries.length - passedCount,
            completedRunCount: input.entries.filter((entry) => entry.runId).length,
            iterations: input.entries.reduce(
                (sum, entry) => sum + (entry.iterations ?? 0),
                0
            ),
            usage,
            failures,
        },
        cases: input.entries,
        paths: input.paths,
    };
}

function aggregateUsage(
    entries: readonly EvalSuiteCaseResult[]
): EvalSuiteReport["totals"]["usage"] {
    const usages = entries.map((entry) => entry.usage);
    if (usages.every((usage) => usage === undefined)) return null;
    const complete = usages.every(
        (usage) => usage !== undefined &&
            usage.estimated === false &&
            usage.outputTokens !== undefined &&
            usage.totalTokens !== undefined
    );
    return {
        inputTokens: usages.reduce(
            (sum, usage) => sum + (usage?.inputTokens ?? 0),
            0
        ),
        ...(complete
            ? {
                outputTokens: usages.reduce(
                    (sum, usage) => sum + (usage?.outputTokens ?? 0),
                    0
                ),
                totalTokens: usages.reduce(
                    (sum, usage) => sum + (usage?.totalTokens ?? 0),
                    0
                ),
            }
            : {}),
        estimated: !complete,
    };
}

async function createSuitePaths(evalRoot: string): Promise<{
    suiteId: string;
    suiteDirectory: string;
    report: string;
}> {
    const suitesRoot = join(resolve(evalRoot), "suites");
    await mkdir(suitesRoot, {recursive: true, mode: 0o700});
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const suiteId = createSuiteId();
        const suiteDirectory = join(suitesRoot, suiteId);
        try {
            await mkdir(suiteDirectory, {mode: 0o700});
            return {
                suiteId,
                suiteDirectory,
                report: join(suiteDirectory, "suite-report.json"),
            };
        } catch (error) {
            if (!isAlreadyExists(error)) throw error;
        }
    }
    throw new Error("无法创建唯一的 Eval Suite 目录");
}

function createSuiteId(): string {
    const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    return `${timestamp}_suite_${randomUUID().slice(0, 8)}`;
}

function boundedMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= 2_000 ? message : `${message.slice(0, 1_999)}…`;
}

function notify(callback: () => void): void {
    try {
        callback();
    } catch {
        // Live presentation cannot change Suite execution or reports.
    }
}

function isAlreadyExists(error: unknown): boolean {
    return typeof error === "object" && error !== null &&
        "code" in error && error.code === "EEXIST";
}
