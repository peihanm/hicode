import type {TurnResult} from "pillar/sdk";
import type {
    EvalAssertion,
    EvalBudget,
    EvalBudgetActual,
    EvalBudgetSummary,
} from "./types.js";

const BUDGET_FIELDS = [
    "maxIterations",
    "maxInputTokens",
    "maxOutputTokens",
    "maxTotalTokens",
    "maxDurationMs",
] as const;

interface BudgetCheck {
    id: string;
    label: string;
    limit: keyof EvalBudget;
    actual: keyof EvalBudgetActual;
}

const BUDGET_CHECKS: readonly BudgetCheck[] = [
    {
        id: "budget:iterations",
        label: "迭代次数不超过预算",
        limit: "maxIterations",
        actual: "iterations",
    },
    {
        id: "budget:input-tokens",
        label: "输入 Token 不超过预算",
        limit: "maxInputTokens",
        actual: "inputTokens",
    },
    {
        id: "budget:output-tokens",
        label: "输出 Token 不超过预算",
        limit: "maxOutputTokens",
        actual: "outputTokens",
    },
    {
        id: "budget:total-tokens",
        label: "总 Token 不超过预算",
        limit: "maxTotalTokens",
        actual: "totalTokens",
    },
    {
        id: "budget:duration-ms",
        label: "Turn 耗时不超过预算",
        limit: "maxDurationMs",
        actual: "durationMs",
    },
];

export function mergeEvalBudget(
    base: EvalBudget,
    overrides: EvalBudget | undefined
): EvalBudget {
    const merged: EvalBudget = {...base};
    if (!overrides) return merged;
    for (const field of BUDGET_FIELDS) {
        const value = overrides[field];
        if (value !== undefined) merged[field] = value;
    }
    return merged;
}

export function evaluateEvalBudget(
    result: TurnResult | undefined,
    limits: EvalBudget
): {summary: EvalBudgetSummary; assertions: EvalAssertion[]} {
    const actual: EvalBudgetActual = {
        iterations: result?.iterations,
        inputTokens: result?.usage?.inputTokens,
        outputTokens: result?.usage?.outputTokens,
        totalTokens: result?.usage?.totalTokens,
        durationMs: result?.durationMs,
    };
    const assertions = BUDGET_CHECKS.flatMap((check) => {
        const limit = limits[check.limit];
        if (limit === undefined) return [];
        const value = actual[check.actual];
        return [{
            id: check.id,
            label: check.label,
            passed: value !== undefined && value <= limit,
            expected: `<= ${limit}`,
            actual: value === undefined ? "missing" : String(value),
            ...(value === undefined
                ? {detail: "TurnResult 未提供该预算所需的指标"}
                : {}),
        }];
    });
    return {
        summary: {
            limits,
            actual,
            passed: assertions.every((assertion) => assertion.passed),
        },
        assertions,
    };
}
