import {randomUUID} from "node:crypto";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import { createSubagentFactories } from "../../src/subagents/runSubagent.js";
import type {AgentRunner} from "../../src/agent/index.js";
import type {
  CreateSubagentThread,
  SubagentRequest,
} from "../../src/subagents/types.js";
import {
  runAgentForTest,
  type AgentTestOptions,
} from "./agent.js";
import {type SubagentRegistry} from "../../src/subagents/index.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {
  createTestToolResultStore,
  type TestToolResultStoreOptions,
} from "./toolResultStore.js";

interface SubagentTestOptions extends Pick<Parameters<CreateSubagentThread>[0], "parentContext" | "onEvent"> {
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
  const factory = createSubagentFactories({
    primaryRunAgent: runAgent,
    createToolResultStore: (cwd, sessionId) =>
      createTestToolResultStore(cwd, sessionId, toolResultStoreOptions),
    registry,
  });
  const runner = async (request: SubagentRequest) => {
    const thread = factory.createSubagentThread({...options, agentId: randomUUID()}, request);
    try {return await thread.run({prompt: request.prompt, signal: options.parentContext.signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});}
    finally {await thread.close();}
  };
  return Object.assign(runner, {registry, createThread: factory.createSubagentThread});
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
    createToolResultStore: (cwd, sessionId) =>
      createTestToolResultStore(cwd, sessionId, toolResultStoreOptions),
    registry,
  }).createSubagentThread(options, request);
}
