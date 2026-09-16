import type {TurnResult} from "hicode/sdk";
import type {EvalAssertion, EvalFailureKind} from "./types.js";

export function classifyEvalFailure(
    error: {code: string; message: string} | undefined,
    assertions: readonly EvalAssertion[],
    result: TurnResult | undefined
): EvalFailureKind {
    if (assertions.some((assertion) => assertion.id === "verifier-runtime")) {
        return "verifier";
    }
    if (error) {
        return /provider|stream|usage|api[_ ]?key|api\s+\d{3}|llm api|http|qwen|deepseek|glm|dashscope|余额不足|资源包|缺少\s+\w+_KEY|missing\s+\w+_KEY/i.test(
            `${error.code} ${error.message}`
        )
            ? "provider"
            : "runtime";
    }
    if (result?.stopReason === "interrupted") return "runtime";
    if (assertions.some((assertion) =>
        assertion.id.startsWith("budget:") && !assertion.passed
    )) {
        return "budget";
    }
    return "agent";
}
