import {lstat, readFile} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";
import type {
    EvalFailureKind,
    EvalInspection,
} from "./types.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS_BYTES = 64 * 1024 * 1024;
const MAX_EVENTS = 200_000;
const PREVIEW_CHARACTERS = 2_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export async function inspectEvalRun(
    evalRoot: string,
    runId: string,
    nowMs = Date.now()
): Promise<EvalInspection> {
    if (!isAbsolute(evalRoot)) throw new Error("Eval Root 必须是绝对路径");
    if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
        throw new Error("Eval Run id 非法");
    }
    const runDirectory = join(resolve(evalRoot), "runs", runId);
    await requireDirectory(runDirectory);
    const paths = {
        runDirectory,
        manifest: join(runDirectory, "manifest.json"),
        report: join(runDirectory, "report.json"),
        transcript: join(runDirectory, "transcript.json"),
        sdkEvents: join(runDirectory, "sdk-events.jsonl"),
        verification: join(runDirectory, "verification.json"),
        diff: join(runDirectory, "diff.patch"),
        workspace: join(runDirectory, "workspace"),
        hicodeHome: join(runDirectory, "hicode-home"),
    };
    const issues: string[] = [];
    const manifest = validateRunArtifact(
        await readOptionalJson(paths.manifest, issues),
        "manifest.json",
        runId,
        issues
    );
    const report = validateRunArtifact(
        await readOptionalJson(paths.report, issues),
        "report.json",
        runId,
        issues
    );
    const transcript = validateSchemaArtifact(
        await readOptionalJson(paths.transcript, issues),
        "transcript.json",
        issues
    );
    const events = await readEvents(paths.sdkEvents, issues);
    const observed = observeEvents(events, issues, nowMs);

    const manifestStatus = parseManifestStatus(manifest);
    const passed = optionalBoolean(report?.passed);
    const status = passed === true
        ? "completed"
        : passed === false
            ? "failed"
            : manifestStatus;
    const reportCaseId = optionalText(report?.caseId);
    const manifestCaseId = optionalText(manifest?.caseId);
    if (reportCaseId && manifestCaseId && reportCaseId !== manifestCaseId) {
        issues.push("manifest.json 与 report.json 的 caseId 不一致");
    }
    const caseId = reportCaseId ?? manifestCaseId;
    const failureKind = parseFailureKind(report?.failureKind);
    const error = parseError(report?.error);
    const turn = parseTurn(report?.result);
    const usage = parseUsage(report?.result);
    const failedAssertions = parseFailedAssertions(report?.assertions);
    const changedPaths = parseTextArray(report?.changedPaths, 10_000);
    const finalResponse = optionalText(transcript?.finalResponse);

    if (!manifest) issues.push("缺少 manifest.json");
    if (!report) issues.push("缺少最终 report.json");
    if (events.length === 0) issues.push("没有可用的 SDK event");

    return {
        schemaVersion: 1,
        runId,
        caseId,
        status,
        passed,
        failureKind,
        summary: summarize({
            status,
            failureKind,
            error,
            failedAssertions,
        }),
        error,
        turn,
        usage,
        lastEvent: observed.lastEvent,
        lastProgress: observed.lastProgress,
        interactions: observed.interactions,
        failedAssertions,
        failedTools: observed.failedTools,
        changedPaths,
        finalResponsePreview: finalResponse
            ? bounded(finalResponse, PREVIEW_CHARACTERS)
            : undefined,
        issues: [...new Set(issues)].slice(0, 100),
        paths,
    };
}

function observeEvents(
    events: readonly Record<string, unknown>[],
    issues: string[],
    nowMs: number
): Pick<EvalInspection, "lastEvent" | "lastProgress" | "interactions" | "failedTools"> {
    let lastEvent: EvalInspection["lastEvent"];
    let lastProgress: EvalInspection["lastProgress"];
    const interactionStarts = new Map<string, number>();
    let interactionStarted = 0;
    let interactionCompleted = 0;
    let totalWaitMs = 0;
    let maxWaitMs = 0;
    const failedTools: EvalInspection["failedTools"] = [];
    let previousSequence = 0;

    for (const event of events) {
        if (event.protocolVersion !== 1) {
            issues.push("存在不支持 protocolVersion 的 SDK event");
            continue;
        }
        const type = optionalText(event.type);
        const sequence = optionalMetric(event.sequence);
        const emittedAt = optionalTimestamp(event.emittedAt);
        if (!type || sequence === undefined || !emittedAt) {
            issues.push("存在缺少 type、sequence 或 emittedAt 的 SDK event");
            continue;
        }
        if (sequence <= previousSequence) {
            issues.push("SDK event sequence 不是严格递增");
        }
        previousSequence = Math.max(previousSequence, sequence);
        const emittedMs = Date.parse(emittedAt);
        lastEvent = {
            type,
            sequence,
            emittedAt,
            ageMs: Math.max(0, nowMs - emittedMs),
        };
        if (type === "turn.progress") {
            const phase = optionalText(event.phase);
            if (phase) {
                lastProgress = {
                    phase,
                    emittedAt,
                    estimatedOutputTokens: optionalMetric(
                        event.estimatedOutputTokens
                    ),
                    toolName: optionalText(event.toolName),
                    idleMilliseconds: optionalMetric(event.idleMilliseconds),
                };
            }
            continue;
        }
        if (type !== "item.started" && type !== "item.completed") continue;
        const item = isRecord(event.item) ? event.item : undefined;
        if (!item) continue;
        if (item.type === "interaction") {
            const request = isRecord(item.request) ? item.request : undefined;
            const requestId = optionalText(request?.requestId);
            if (!requestId) continue;
            if (type === "item.started") {
                interactionStarted += 1;
                if (interactionStarts.has(requestId)) {
                    issues.push(`Interaction ${requestId} 重复 started`);
                }
                interactionStarts.set(requestId, emittedMs);
            } else {
                interactionCompleted += 1;
                const started = interactionStarts.get(requestId);
                if (started !== undefined) {
                    const waitMs = Math.max(0, emittedMs - started);
                    totalWaitMs += waitMs;
                    maxWaitMs = Math.max(maxWaitMs, waitMs);
                    interactionStarts.delete(requestId);
                } else {
                    issues.push(`Interaction ${requestId} completed 缺少 started`);
                }
            }
        }
        if (type === "item.completed" && item.type === "tool_call") {
            const status = optionalText(item.status) ?? "unknown";
            const outcome = optionalText(item.outcome);
            if (status !== "completed" || (outcome && outcome !== "ok")) {
                failedTools.push({
                    name: optionalText(item.name) ?? "unknown",
                    status,
                    outcome,
                    resultPreview: optionalText(item.resultPreview)
                        ? bounded(String(item.resultPreview), PREVIEW_CHARACTERS)
                        : undefined,
                });
            }
        }
    }
    return {
        lastEvent,
        lastProgress,
        interactions: {
            started: interactionStarted,
            completed: interactionCompleted,
            pending: interactionStarts.size,
            totalWaitMs,
            maxWaitMs,
        },
        failedTools: failedTools.slice(0, 100),
    };
}

function parseFailedAssertions(
    value: unknown
): EvalInspection["failedAssertions"] {
    if (!Array.isArray(value)) return [];
    const failed: EvalInspection["failedAssertions"] = [];
    for (const candidate of value.slice(0, 10_000)) {
        if (!isRecord(candidate) || candidate.passed !== false) continue;
        const process = isRecord(candidate.process) ? candidate.process : undefined;
        const id = optionalText(candidate.id);
        const label = optionalText(candidate.label);
        if (!id || !label) continue;
        failed.push({
            id,
            label,
            actual: optionalText(candidate.actual)
                ? bounded(String(candidate.actual), PREVIEW_CHARACTERS)
                : undefined,
            detail: optionalText(candidate.detail)
                ? bounded(String(candidate.detail), PREVIEW_CHARACTERS)
                : undefined,
            exitCode: optionalInteger(process?.exitCode),
            stderrPreview: optionalText(process?.stderr)
                ? bounded(String(process?.stderr), PREVIEW_CHARACTERS)
                : undefined,
        });
    }
    return failed.slice(0, 100);
}

function parseTurn(value: unknown): EvalInspection["turn"] {
    if (!isRecord(value)) return undefined;
    const turn = {
        stopReason: optionalText(value.stopReason),
        abortReason: optionalText(value.abortReason),
        iterations: optionalMetric(value.iterations),
        durationMs: optionalMetric(value.durationMs),
    };
    return Object.values(turn).some((item) => item !== undefined)
        ? turn
        : undefined;
}

function parseUsage(result: unknown): EvalInspection["usage"] {
    if (!isRecord(result) || !isRecord(result.usage)) return undefined;
    const inputTokens = optionalMetric(result.usage.inputTokens);
    if (inputTokens === undefined) return undefined;
    return {
        inputTokens,
        outputTokens: optionalMetric(result.usage.outputTokens),
        totalTokens: optionalMetric(result.usage.totalTokens),
        estimated: optionalBoolean(result.usage.estimated),
    };
}

function parseError(value: unknown): EvalInspection["error"] {
    if (!isRecord(value)) return undefined;
    const message = optionalText(value.message);
    if (!message) return undefined;
    return {
        code: optionalText(value.code),
        message: bounded(message, PREVIEW_CHARACTERS),
    };
}

function parseManifestStatus(
    manifest: Record<string, unknown> | undefined
): EvalInspection["status"] {
    const status = optionalText(manifest?.status);
    if (status === "running" || status === "completed" || status === "failed") {
        return status;
    }
    return "unknown";
}

function parseFailureKind(value: unknown): EvalFailureKind | undefined {
    return value === "agent" || value === "budget" || value === "provider" ||
        value === "runtime" || value === "verifier"
        ? value
        : undefined;
}

function summarize(input: {
    status: EvalInspection["status"];
    failureKind?: EvalFailureKind;
    error?: EvalInspection["error"];
    failedAssertions: EvalInspection["failedAssertions"];
}): string {
    if (input.status === "completed") return "Eval Run 已通过";
    const assertion = input.failedAssertions[0];
    if (assertion) {
        const detail = assertion.actual ?? assertion.detail ?? "failed";
        return `${input.failureKind ?? "failure"}: ${assertion.label} (${detail})`;
    }
    if (input.error) {
        return `${input.failureKind ?? input.error.code ?? "error"}: ${input.error.message}`;
    }
    if (input.status === "running") {
        return "Run 没有最终 report；可能仍在运行或被外部中断";
    }
    return "Run 缺少可确认的最终结果";
}

async function readOptionalJson(
    path: string,
    issues: string[]
): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
        text = await readBoundedFile(path, MAX_JSON_BYTES);
    } catch (error) {
        if (isMissing(error)) return undefined;
        issues.push(`${path}: ${formatError(error)}`);
        return undefined;
    }
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!isRecord(parsed)) throw new Error("必须是 JSON object");
        return parsed;
    } catch (error) {
        issues.push(`${path}: ${formatError(error)}`);
        return undefined;
    }
}

function validateRunArtifact(
    value: Record<string, unknown> | undefined,
    label: string,
    runId: string,
    issues: string[]
): Record<string, unknown> | undefined {
    const validated = validateSchemaArtifact(value, label, issues);
    if (!validated) return undefined;
    if (validated.runId !== runId) {
        issues.push(`${label} 的 runId 与目录不一致`);
        return undefined;
    }
    return validated;
}

function validateSchemaArtifact(
    value: Record<string, unknown> | undefined,
    label: string,
    issues: string[]
): Record<string, unknown> | undefined {
    if (!value) return undefined;
    if (value.schemaVersion !== 1) {
        issues.push(`${label} schemaVersion 非法`);
        return undefined;
    }
    return value;
}

async function readEvents(
    path: string,
    issues: string[]
): Promise<Record<string, unknown>[]> {
    let text: string;
    try {
        text = await readBoundedFile(path, MAX_EVENTS_BYTES);
    } catch (error) {
        if (!isMissing(error)) issues.push(`${path}: ${formatError(error)}`);
        return [];
    }
    const lines = text.split("\n");
    const events: Record<string, unknown>[] = [];
    for (const [index, line] of lines.slice(0, MAX_EVENTS).entries()) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line) as unknown;
            if (!isRecord(parsed)) throw new Error("event 必须是 object");
            events.push(parsed);
        } catch (error) {
            issues.push(`sdk-events.jsonl:${index + 1}: ${formatError(error)}`);
        }
    }
    if (lines.length > MAX_EVENTS) {
        issues.push(`SDK event 超过 ${MAX_EVENTS} 条，只检查前 ${MAX_EVENTS} 条`);
    }
    return events;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("必须是普通文件且不能是 Symlink");
    }
    if (stat.size > maxBytes) throw new Error(`超过 ${maxBytes} bytes`);
    return readFile(path, "utf8");
}

async function requireDirectory(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Eval Run 必须是普通目录且不能是 Symlink");
    }
}

function parseTextArray(value: unknown, maxItems: number): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, maxItems)
        .filter((item): item is string =>
            typeof item === "string" && item.length > 0 && item.length <= 10_000
        );
}

function optionalText(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= 1_000_000
        ? value
        : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
    const text = optionalText(value);
    return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function optionalMetric(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}

function optionalInteger(value: unknown): number | undefined {
    const metric = optionalMetric(value);
    return metric !== undefined && Number.isInteger(metric) ? metric : undefined;
}

function bounded(value: string, maxCharacters: number): string {
    return value.length <= maxCharacters
        ? value
        : `${value.slice(0, maxCharacters - 1)}…`;
}

function isMissing(error: unknown): boolean {
    return isRecord(error) && error.code === "ENOENT";
}

function formatError(error: unknown): string {
    return bounded(error instanceof Error ? error.message : String(error), 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
