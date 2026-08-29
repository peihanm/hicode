import { createCompactHistoryRunner } from "../../src/context/compact.js";
import { createCompactSummaryGenerator } from "../../src/context/compactSummary.js";
import type { LLMCaller } from "../../src/llm/types.js";

type CompactHistoryInput = Parameters<
  ReturnType<typeof createCompactHistoryRunner>
>[0];
type CompactSummaryInput = Parameters<
  ReturnType<typeof createCompactSummaryGenerator>
>[0];

export function compactHistoryForTest(
  input: CompactHistoryInput & { callLLM?: LLMCaller }
) {
  const { callLLM: callLLMOverride, ...options } = input;
  const generateSummary = createCompactSummaryGenerator({
    callLLM: callLLMOverride ?? unexpectedCompactLLM,
  });
  return createCompactHistoryRunner({ generateSummary })(options);
}

export function generateCompactSummaryForTest(
  input: CompactSummaryInput & { callLLM?: LLMCaller }
) {
  const { callLLM: callLLMOverride, ...options } = input;
  return createCompactSummaryGenerator({
    callLLM: callLLMOverride ?? unexpectedCompactLLM,
  })(options);
}

const unexpectedCompactLLM: LLMCaller = async () => {
  throw new Error("compact test 触发了未配置的 callLLM fake");
};
