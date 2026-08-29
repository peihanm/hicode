import {
  createAgentRunner,
  type AgentRunOptions,
  type AgentToolBindings,
  type AgentResult,
  EMPTY_AGENT_INPUT_CHANNEL,
  type AgentInputChannel,
} from "../../src/agent/index.js";
import type { CompactHistoryRunner } from "../../src/agent/invokePreparation.js";
import type { LLMCaller, Message } from "../../src/llm/types.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { AgentEvent } from "../../src/agent/types.js";
import { createToolRuntime } from "../../src/tools/registry.js";

export interface AgentTestOptions
  extends Omit<AgentRunOptions, keyof AgentToolBindings>,
    Partial<AgentToolBindings> {
  callLLM?: LLMCaller;
  compactHistory?: CompactHistoryRunner;
  turnId?: string;
  inputChannel?: AgentInputChannel;
}

export function runAgentForTest(
  userInput: string,
  history: Message[],
  onEvent: (event: AgentEvent) => void,
  ctx: ToolContext,
  test: AgentTestOptions = {}
): Promise<AgentResult> {
  const {
    callLLM: callLLMOverride,
    compactHistory: compactHistoryOverride,
    turnId,
    inputChannel = EMPTY_AGENT_INPUT_CHANNEL,
    ...options
  } = test;
  const toolRuntime = createToolRuntime();
  const callLLM: LLMCaller =
    callLLMOverride ??
    (async () => {
      throw new Error("runAgentForTest 需要显式提供 callLLM fake");
    });
  const compactHistory: CompactHistoryRunner =
    compactHistoryOverride ??
    (async ({ preTokenCount }) => ({
      compacted: false,
      preTokenCount,
      threshold: Number.MAX_SAFE_INTEGER,
    }));
  return createAgentRunner({
    callLLM,
    compactHistory,
    ...(turnId ? { createTurnId: () => turnId } : {}),
  })(userInput, history, onEvent, ctx, inputChannel, {
    ...options,
    getToolSchemas: test.getToolSchemas ?? toolRuntime.getToolSchemas,
    executeTool: test.executeTool ?? toolRuntime.executeTool,
    isToolConcurrencySafe:
      test.isToolConcurrencySafe ?? toolRuntime.isConcurrencySafe,
  });
}
