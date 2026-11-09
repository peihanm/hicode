import {inlineToolResult} from "../../src/tools/execute.js";
import type {ToolExecutor} from "../../src/agent/toolBatch.js";
import type {MessageContent} from "../../src/images/content.js";
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
    Partial<Omit<AgentToolBindings, "executeTool">> {
  executeTool?: (...args: Parameters<ToolExecutor>) => Promise<Awaited<ReturnType<ToolExecutor>> | string>;
  callLLM?: LLMCaller;
  compactHistory?: CompactHistoryRunner;
  inputChannel?: AgentInputChannel;
}

export function runAgentForTest(
  userInput: MessageContent,
  history: Message[],
  onEvent: (event: AgentEvent) => void,
  ctx: ToolContext,
  test: AgentTestOptions = {}
): Promise<AgentResult> {
  const {
    callLLM: callLLMOverride,
    compactHistory: compactHistoryOverride,
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
  })(userInput, history, onEvent, ctx, inputChannel, {
    ...options,
    getToolSchemas: test.getToolSchemas ?? toolRuntime.getToolSchemas,
    executeTool: async (...args) => {
      const result = await (test.executeTool ?? toolRuntime.executeTool)(...args);
      return typeof result === "string" ? inlineToolResult(result, "ok") : result;
    },
    isToolConcurrencySafe:
      test.isToolConcurrencySafe ?? toolRuntime.isConcurrencySafe,
  });
}
