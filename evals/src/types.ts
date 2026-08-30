import type {
    HostDiagnostic,
    InteractionRequest,
    InteractionResponse,
    LoadPillarHostConfigOptions,
    ThreadEvent,
    ThreadInfo,
    TurnOptions,
    TurnResult,
} from "pillar/sdk";

export type EvalKeepPolicy = "all" | "failed" | "none";
export type EvalFailureKind =
    | "agent"
    | "budget"
    | "provider"
    | "runtime"
    | "verifier";
export type EvalModelSource = NonNullable<
    LoadPillarHostConfigOptions["source"]
>;
export type EvalPermissionMode = NonNullable<TurnOptions["permissionMode"]>;

export interface EvalCommand {
    id: string;
    label: string;
    argv: readonly string[];
    timeoutMs?: number;
}

export interface EvalBudget {
    maxIterations?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    maxDurationMs?: number;
}

export interface EvalBudgetActual {
    iterations?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
}

export interface EvalBudgetSummary {
    limits: EvalBudget;
    actual: EvalBudgetActual;
    passed: boolean;
}

export interface EvalCase {
    id: string;
    description: string;
    fixtureDirectory: string;
    prompt: string;
    permissionMode: EvalPermissionMode;
    maxIterations: number;
    timeoutMs: number;
    budget: EvalBudget;
    requiredChangedPaths: readonly string[];
    forbiddenChangedPrefixes: readonly string[];
    commands: readonly EvalCommand[];
}

export interface EvalRunOptions {
    caseId: string;
    evalRoot: string;
    settingsFile?: string;
    envFile?: string;
    source?: EvalModelSource;
    model?: string;
    keep: EvalKeepPolicy;
    maxIterations?: number;
    timeoutMs?: number;
    budget?: EvalBudget;
}

export interface EvalRunObserver {
    onEvent?(event: ThreadEvent): void;
}

export type EvalLivePhase =
    | "starting"
    | "model_waiting"
    | "reasoning"
    | "content"
    | "tool_input"
    | "retrying"
    | "stalled"
    | "tool"
    | "interaction"
    | "item"
    | "completed"
    | "failed";

export interface EvalLiveStatus {
    phase: EvalLivePhase;
    detail: string;
    startedAtMs: number;
    lastSignalAtMs: number;
    sequence: number;
    estimatedOutputTokens?: number;
}

export interface EvalRunPaths {
    runDirectory: string;
    workspace: string;
    pillarHome: string;
    verifierHome: string;
    manifest: string;
    report: string;
    transcript: string;
    sdkEvents: string;
    interactions: string;
    diagnostics: string;
    verification: string;
    diff: string;
}

export interface EvalProcessResult {
    argv: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    outputTruncated: boolean;
    spawnError?: string;
}

export interface EvalAssertion {
    id: string;
    label: string;
    passed: boolean;
    expected?: string;
    actual?: string;
    detail?: string;
    process?: EvalProcessResult;
}

export interface EvalInteractionRecord {
    timestamp: string;
    request: InteractionRequest;
    response: InteractionResponse;
}

export interface EvalTranscript {
    schemaVersion: 1;
    caseId: string;
    threadId?: string;
    prompt: string;
    finalResponse?: string;
    stopReason?: string;
    toolCalls: Array<{
        name: string;
        status: string;
        outcome?: string;
        arguments: unknown;
        resultPreview?: string;
    }>;
    fileChanges: Array<{
        path: string;
        kind: string;
    }>;
    interactions: EvalInteractionRecord[];
}

export interface EvalManifest {
    schemaVersion: 1;
    runId: string;
    caseId: string;
    description: string;
    status: "running" | "completed" | "failed";
    startedAt: string;
    finishedAt?: string;
    source?: EvalModelSource;
    model?: string;
    envFileProvided: boolean;
    keep: EvalKeepPolicy;
    paths: EvalRunPaths;
    baselineCommit?: string;
    sessionId?: string;
    sessionIndexPath?: string;
    sessionEventsPath?: string;
}

export interface EvalReport {
    schemaVersion: 1;
    runId: string;
    caseId: string;
    passed: boolean;
    failureKind?: EvalFailureKind;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    source?: EvalModelSource;
    model?: string;
    threadInfo?: ThreadInfo;
    result?: TurnResult;
    budget: EvalBudgetSummary;
    error?: {code: string; message: string};
    assertions: EvalAssertion[];
    changedPaths: string[];
    diagnostics: HostDiagnostic[];
    interactionCount: number;
    eventCount: number;
    retained: {workspace: boolean; pillarHome: boolean};
    paths: EvalRunPaths;
    trend: {
        reportPath: string;
        updated: boolean;
        issue?: string;
    };
}

export interface EvalTrendMetrics {
    durationMs?: number;
    iterations?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

export interface EvalTrendPoint extends EvalTrendMetrics {
    runId: string;
    finishedAt: string;
    passed: boolean;
    failureKind?: EvalFailureKind;
    budgetPassed?: boolean;
}

export interface EvalTrendGroup {
    caseId: string;
    source?: EvalModelSource;
    model?: string;
    runCount: number;
    passedCount: number;
    passRate: number;
    latestFinishedAt: string;
    averages: EvalTrendMetrics;
    latestDelta: EvalTrendMetrics;
    recent: EvalTrendPoint[];
}

export interface EvalTrendIssue {
    reportPath: string;
    message: string;
}

export interface EvalTrendReport {
    schemaVersion: 1;
    generatedAt: string;
    evalRoot: string;
    runCount: number;
    skippedReportCount: number;
    issues: EvalTrendIssue[];
    groups: EvalTrendGroup[];
}

export interface EvalExecutionState {
    events: ThreadEvent[];
    diagnostics: HostDiagnostic[];
    interactions: EvalInteractionRecord[];
}
