import type {
  LLMCaller,
  LLMCallOptions,
  LLMCallResult,
  ToolCall,
} from "../../src/llm/types.js";

type FakeLLMStep =
  | LLMCallResult
  | ((options: LLMCallOptions, callIndex: number) => LLMCallResult | Promise<LLMCallResult>);

const EMPTY_USAGE = {
  prompt_tokens: 12,
  completion_tokens: 4,
  total_tokens: 16,
};

export function assistantText(content: string | null): LLMCallResult {
  return {
    message: { role: "assistant", content },
    toolCalls: [],
    usage: EMPTY_USAGE,
  };
}
export function assistantToolCall(
  name: string,
  args: unknown,
  id = "tool-call-1"
): LLMCallResult {
  const toolCall: ToolCall = {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };

  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    },
    toolCalls: [toolCall],
    usage: EMPTY_USAGE,
  };
}

export function createFakeLLM(steps: FakeLLMStep[]): {
  callLLM: LLMCaller;
  calls: LLMCallOptions[];
} {
  const calls: LLMCallOptions[] = [];

  const callLLM: LLMCaller = async (
    messages,
    tools,
    storage,
    cwd = process.cwd(),
    model = "glm-test",
    kind = "main",
    signal
  ) => {
    const options: LLMCallOptions = {
      messages: structuredClone(messages),
      tools: structuredClone(tools),
      storage,
      cwd,
      model,
      kind,
      signal,
    };
    const callIndex = calls.length;
    calls.push(options);

    const step = steps[callIndex];
    if (!step) {
      throw new Error(`Fake LLM 没有配置第 ${callIndex + 1} 次调用`);
    }
    return typeof step === "function" ? step(options, callIndex) : step;
  };

  return { callLLM, calls };
}
