import {config as loadEnvFile} from "dotenv";
import {writeFile} from "node:fs/promises";
import {
    collectTurnResult,
    loadPillarHostConfig,
    Pillar,
    PillarSDKError,
    type InteractionRequest,
    type InteractionResponse,
    type ThreadEvent,
    type ThreadInfo,
    type TurnResult,
} from "pillar/sdk";
import {
    appendJsonLine,
    applyRetentionPolicy,
    collectWorkspaceDiff,
    locateSessionArtifacts,
    prepareEvalRun,
    writeJsonAtomic,
} from "./artifacts.js";
import {evaluateEvalBudget, mergeEvalBudget} from "./budget.js";
import {getEvalCase} from "./cases.js";
import {classifyEvalFailure} from "./failure.js";
import {
    getEvalTrendReportPath,
    refreshEvalTrendReport,
} from "./trends.js";
import type {
    EvalAssertion,
    EvalExecutionState,
    EvalManifest,
    EvalReport,
    EvalRunObserver,
    EvalRunOptions,
    EvalTranscript,
} from "./types.js";
import {runEvalVerification} from "./verifier.js";

export async function runEvalCase(
    options: EvalRunOptions,
    observer: EvalRunObserver = {}
): Promise<EvalReport> {
    const evalCase = getEvalCase(options.caseId);
    const budget = mergeEvalBudget(evalCase.budget, options.budget);
    loadExplicitEnvironment(options.envFile);
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    const prepared = await prepareEvalRun(evalCase, {
        evalRoot: options.evalRoot,
        settingsFile: options.settingsFile,
        source: options.source,
        model: options.model,
        envFileProvided: options.envFile !== undefined,
        keep: options.keep,
    });
    const state: EvalExecutionState = {
        events: [],
        diagnostics: [],
        interactions: [],
    };
    let pillar: Pillar | undefined;
    let threadInfo: ThreadInfo | undefined;
    let result: TurnResult | undefined;
    let runError: {code: string; message: string} | undefined;
    let resolvedSource = options.source;
    let resolvedModel = options.model;
    const turnController = new AbortController();
    const timeoutMs = options.timeoutMs ?? evalCase.timeoutMs;
    const timeout = setTimeout(
        () => turnController.abort("timeout"),
        timeoutMs
    );
    timeout.unref?.();

    try {
        const hostConfig = loadPillarHostConfig({
            cwd: prepared.paths.workspace,
            pillarHome: prepared.paths.pillarHome,
            source: options.source,
            model: options.model,
        });
        resolvedSource =
            hostConfig.pillarOptions.settings.models.primary.source;
        resolvedModel = hostConfig.pillarOptions.settings.models.primary.model;
        pillar = await Pillar.create({
            ...hostConfig.pillarOptions,
            host: {
                onInteraction: async (request) => {
                    const response = decideEvalInteraction(request);
                    const record = {
                        timestamp: new Date().toISOString(),
                        request,
                        response,
                    };
                    state.interactions.push(record);
                    await appendJsonLine(prepared.paths.interactions, record);
                    return response;
                },
                onDiagnostic: async (diagnostic) => {
                    state.diagnostics.push(diagnostic);
                    await appendJsonLine(prepared.paths.diagnostics, {
                        timestamp: new Date().toISOString(),
                        ...diagnostic,
                    });
                },
            },
        });
        const thread = await pillar.startThread({
            permissionMode: evalCase.permissionMode,
        });
        threadInfo = thread.getInfo();
        const streamed = await thread.runStreamed(evalCase.prompt, {
            signal: turnController.signal,
            permissionMode: evalCase.permissionMode,
            maxIterations: options.maxIterations ?? evalCase.maxIterations,
        });
        result = await collectTurnResult(
            recordEvents(
                streamed.events,
                state,
                prepared.paths.sdkEvents,
                observer
            )
        );
    } catch (error) {
        runError = toErrorInfo(error, state.events);
    } finally {
        clearTimeout(timeout);
        try {
            await pillar?.close();
        } catch (error) {
            runError ??= toErrorInfo(error, state.events);
        }
    }

    let changedPaths: string[] = [];
    let diff = "";
    const assertions: EvalAssertion[] = [
        {
            id: "sdk-turn-completed",
            label: "SDK Turn 正常完成",
            passed: result?.stopReason === "completed",
            expected: "completed",
            actual: result?.stopReason ?? runError?.code ?? "missing result",
            ...(runError ? {detail: runError.message} : {}),
        },
    ];
    try {
        const workspaceState = await collectWorkspaceDiff(
            prepared.paths.workspace,
            prepared.baselineCommit,
            prepared.verifierEnvironment
        );
        changedPaths = workspaceState.changedPaths;
        diff = workspaceState.diff;
        await writeFile(prepared.paths.diff, diff, {mode: 0o600});
        assertions.push(
            ...(await runEvalVerification(
                evalCase,
                prepared.paths.workspace,
                changedPaths,
                prepared.verifierEnvironment
            ))
        );
    } catch (error) {
        assertions.push({
            id: "verifier-runtime",
            label: "独立验证器完成",
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
        });
    }

    const budgetEvaluation = evaluateEvalBudget(result, budget);
    assertions.push(...budgetEvaluation.assertions);

    const passed = assertions.every((assertion) => assertion.passed);
    const finishedAt = new Date().toISOString();
    const sessionArtifacts = await locateSessionArtifacts(
        prepared.paths.pillarHome
    );
    const transcript = createTranscript(
        evalCase.id,
        evalCase.prompt,
        result,
        state
    );
    await Promise.all([
        writeJsonAtomic(prepared.paths.transcript, transcript),
        writeJsonAtomic(prepared.paths.verification, assertions),
    ]);
    const retained = await applyRetentionPolicy(
        prepared.paths,
        options.keep,
        passed
    );
    const failureKind = passed
        ? undefined
        : classifyEvalFailure(runError, assertions, result);
    const report: EvalReport = {
        schemaVersion: 1,
        runId: prepared.runId,
        caseId: evalCase.id,
        passed,
        failureKind,
        startedAt,
        finishedAt,
        durationMs: Math.round(performance.now() - startedMs),
        source: resolvedSource,
        model: resolvedModel,
        threadInfo,
        result,
        budget: budgetEvaluation.summary,
        error: runError,
        assertions,
        changedPaths,
        diagnostics: state.diagnostics,
        interactionCount: state.interactions.length,
        eventCount: state.events.length,
        retained,
        paths: prepared.paths,
        trend: {
            reportPath: getEvalTrendReportPath(options.evalRoot),
            updated: false,
        },
    };
    const manifest: EvalManifest = {
        schemaVersion: 1,
        runId: prepared.runId,
        caseId: evalCase.id,
        description: evalCase.description,
        status: passed ? "completed" : "failed",
        startedAt,
        finishedAt,
        source: resolvedSource,
        model: resolvedModel,
        envFileProvided: options.envFile !== undefined,
        keep: options.keep,
        paths: prepared.paths,
        baselineCommit: prepared.baselineCommit,
        sessionId: threadInfo?.id,
        ...sessionArtifacts,
    };
    await Promise.all([
        writeJsonAtomic(prepared.paths.report, report),
        writeJsonAtomic(prepared.paths.manifest, manifest),
    ]);
    try {
        await refreshEvalTrendReport(options.evalRoot);
        report.trend.updated = true;
    } catch (error) {
        report.trend.issue =
            error instanceof Error ? error.message : String(error);
    }
    await writeJsonAtomic(prepared.paths.report, report);
    return report;
}

async function* recordEvents(
    events: AsyncIterable<ThreadEvent>,
    state: EvalExecutionState,
    path: string,
    observer: EvalRunObserver
): AsyncGenerator<ThreadEvent> {
    for await (const event of events) {
        state.events.push(event);
        await appendJsonLine(path, event);
        try {
            observer.onEvent?.(event);
        } catch {
            // Live reporting is observational and cannot change the Eval result.
        }
        yield event;
    }
}

function decideEvalInteraction(
    request: InteractionRequest
): InteractionResponse {
    if (request.kind === "question") {
        return {
            behavior: "deny",
            message: "Eval Case 没有交互式用户回答",
        };
    }
    if (
        request.kind === "permission" &&
        isRecord(request.input) &&
        request.input.sandbox_permissions === "require_escalated"
    ) {
        return {
            behavior: "deny",
            message: "Eval Case 不允许 elevated 工具执行",
        };
    }
    return {behavior: "allow", persistence: "once"};
}

function createTranscript(
    caseId: string,
    prompt: string,
    result: TurnResult | undefined,
    state: EvalExecutionState
): EvalTranscript {
    const toolCalls: EvalTranscript["toolCalls"] = [];
    const fileChanges: EvalTranscript["fileChanges"] = [];
    for (const item of result?.items ?? []) {
        if (item.type === "tool_call") {
            toolCalls.push({
                name: item.name,
                status: item.status,
                outcome: item.outcome,
                arguments: item.arguments,
                resultPreview: item.resultPreview,
            });
        } else if (item.type === "file_change") {
            fileChanges.push(...item.changes.map((change) => ({
                path: change.path,
                kind: change.kind,
            })));
        }
    }
    return {
        schemaVersion: 1,
        caseId,
        threadId: result?.threadId,
        prompt,
        finalResponse: result?.finalResponse,
        stopReason: result?.stopReason,
        toolCalls,
        fileChanges,
        interactions: state.interactions,
    };
}

function toErrorInfo(
    error: unknown,
    events: readonly ThreadEvent[]
): {code: string; message: string} {
    const failed = events.findLast((event) => event.type === "turn.failed");
    if (failed?.type === "turn.failed") return failed.error;
    if (error instanceof PillarSDKError) {
        return {code: error.code, message: error.message};
    }
    return {
        code: "eval_runtime_error",
        message: error instanceof Error ? error.message : String(error),
    };
}

function loadExplicitEnvironment(envFile: string | undefined): void {
    if (!envFile) return;
    const loaded = loadEnvFile({path: envFile, override: true, quiet: true});
    if (loaded.error) {
        throw new Error(`无法加载 Eval env file: ${loaded.error.message}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
