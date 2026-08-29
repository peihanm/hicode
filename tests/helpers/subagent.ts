import { createSubagentRunnerFactory } from "../../src/subagents/runSubagent.js";
import type {AgentRunner} from "../../src/agent/index.js";
import type { CreateSubagentRunnerOptions } from "../../src/subagents/types.js";
import {
  createToolResultStoreFactory,
} from "../../src/toolResults/store.js";
import type {ToolResultStoreOptions} from "../../src/toolResults/types.js";
import {
  runAgentForTest,
  type AgentTestOptions,
} from "./agent.js";
import {
  BUILTIN_SUBAGENT_REGISTRY,
  type SubagentRegistry,
} from "../../src/subagents/index.js";

interface SubagentTestOptions extends CreateSubagentRunnerOptions {
  agentOptions?: Pick<AgentTestOptions, "callLLM" | "compactHistory">;
  toolResultStoreOptions?: ToolResultStoreOptions;
  registry?: SubagentRegistry;
}

export function createSubagentRunnerForTest({
  agentOptions,
  toolResultStoreOptions,
  registry = BUILTIN_SUBAGENT_REGISTRY,
  ...options
}: SubagentTestOptions) {
  const runAgent: AgentRunner = (
    input,
    history,
    onEvent,
    ctx,
    inputChannel,
    runOptions
  ) => runAgentForTest(input, history, onEvent, ctx, {
    ...runOptions,
    ...agentOptions,
    inputChannel,
  });
  return createSubagentRunnerFactory({
    primaryRunAgent: runAgent,
    fastRunAgent: runAgent,
    fastModel: "glm-fast-test",
    createToolResultStore: (cwd, sessionId) =>
      createToolResultStoreFactory(toolResultStoreOptions)(cwd, sessionId),
    registry,
  })(options);
}
