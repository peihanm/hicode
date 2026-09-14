import { createSubagentFactories } from "../../src/subagents/runSubagent.js";
import type {AgentRunner} from "../../src/agent/index.js";
import type {
  CreateSubagentRunnerOptions,
  CreateSubagentThread,
  SubagentRequest,
} from "../../src/subagents/types.js";
import {
  runAgentForTest,
  type AgentTestOptions,
} from "./agent.js";
import {
  BUILTIN_SUBAGENT_REGISTRY,
  type SubagentRegistry,
} from "../../src/subagents/index.js";
import {
  createTestToolResultStore,
  type TestToolResultStoreOptions,
} from "./toolResultStore.js";

interface SubagentTestOptions extends CreateSubagentRunnerOptions {
  agentOptions?: Pick<AgentTestOptions, "callLLM" | "compactHistory">;
  toolResultStoreOptions?: TestToolResultStoreOptions;
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
  return createSubagentFactories({
    primaryRunAgent: runAgent,
    fastRunAgent: runAgent,
    createToolResultStore: (cwd, sessionId) =>
      createTestToolResultStore(cwd, sessionId, toolResultStoreOptions),
    registry,
  }).createSubagentRunner(options);
}

type SubagentThreadTestOptions = Parameters<CreateSubagentThread>[0] & {
  agentOptions?: Pick<AgentTestOptions, "callLLM" | "compactHistory">;
  toolResultStoreOptions?: TestToolResultStoreOptions;
  registry?: SubagentRegistry;
};

export function createSubagentThreadForTest(
  {
    agentOptions,
    toolResultStoreOptions,
    registry = BUILTIN_SUBAGENT_REGISTRY,
    ...options
  }: SubagentThreadTestOptions,
  request: SubagentRequest
) {
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
  return createSubagentFactories({
    primaryRunAgent: runAgent,
    fastRunAgent: runAgent,
    createToolResultStore: (cwd, sessionId) =>
      createTestToolResultStore(cwd, sessionId, toolResultStoreOptions),
    registry,
  }).createSubagentThread(options, request);
}
