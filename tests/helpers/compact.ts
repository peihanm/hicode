import {DEFAULT_CONTEXT_SETTINGS} from "../../src/context/config.js";
import { createCompactHistoryRunner } from "../../src/context/compact.js";
import { createCompactSummaryGenerator } from "../../src/context/compactSummary.js";
import type { LLMCaller } from "../../src/llm/types.js";
import {createTestStorage} from "./tempProject.js";

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
  input: Omit<CompactSummaryInput, "storage" | "contextSettings"> & {
    storage?: CompactSummaryInput["storage"];
    contextSettings?: CompactSummaryInput["contextSettings"];
    callLLM?: LLMCaller;
  }
) {
  const { callLLM: callLLMOverride, ...options } = input;
  return createCompactSummaryGenerator({
    callLLM: callLLMOverride ?? unexpectedCompactLLM,
  })({
    ...options,
    contextSettings: options.contextSettings ?? DEFAULT_CONTEXT_SETTINGS,
    storage: options.storage ?? createTestStorage(options.cwd),
  });
}

const unexpectedCompactLLM: LLMCaller = async () => {
  throw new Error("compact test 触发了未配置的 callLLM fake");
};
