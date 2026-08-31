import type { AgentRunner } from "../../src/agent/index.js";
import { createHeadlessRunner } from "../../src/headless/host.js";
import {
  writeHeadlessDiagnostic,
  writeHeadlessOutput,
} from "../../src/headless/io.js";
import type {
  HeadlessOptions,
  HeadlessOutputFormat,
  HeadlessRunSummary,
} from "../../src/headless/types.js";
import type { CreateLspManager } from "../../src/lsp/types.js";
import type { McpManagerLike } from "../../src/mcp/index.js";
import { createRootRuntimeResources } from "../../src/runtime/resources.js";
import { saveSessionSnapshot } from "../../src/session/index.js";
import { createRootRuntimeResourcesForTest } from "./runtimeResources.js";
import {
  runAgentForTest,
  type AgentTestOptions,
} from "./agent.js";
import {
  createSubagentRunnerForTest,
  createSubagentThreadForTest,
} from "./subagent.js";
import type { AgentRuntime } from "../../src/runtime/agentRuntime.js";
import {createTestStorage} from "./tempProject.js";
import {
  type TestToolResultStoreOptions,
} from "./toolResultStore.js";

interface HeadlessTestOptions {
  agent?: AgentTestOptions;
  signal?: AbortSignal;
  writeOutput?: (
    summary: HeadlessRunSummary,
    format: HeadlessOutputFormat
  ) => void | Promise<void>;
  writeDiagnostic?: (line: string) => void | Promise<void>;
  toolResultStoreOptions?: TestToolResultStoreOptions;
  mcpManager?: McpManagerLike | false;
  createLspManager?: CreateLspManager;
  createResources?: typeof createRootRuntimeResources;
  runAgent?: AgentRunner;
  saveSession?: typeof saveSessionSnapshot;
}

export function runHeadlessForTest(
  options: Omit<HeadlessOptions, "storage"> & {storage?: HeadlessOptions["storage"]},
  test: HeadlessTestOptions = {}
): Promise<HeadlessRunSummary> {
  const agentRuntime: AgentRuntime = {
    runAgent:
      test.runAgent ??
      ((prompt, history, onEvent, ctx, inputChannel, agentOptions) =>
        runAgentForTest(prompt, history, onEvent, ctx, {
          ...agentOptions,
          ...test.agent,
          inputChannel,
        })),
    createSubagentRunner: (subagentOptions) =>
      createSubagentRunnerForTest({
        ...subagentOptions,
        agentOptions: test.agent,
        toolResultStoreOptions: test.toolResultStoreOptions,
      }),
    createSubagentThread: (subagentOptions, request) =>
      createSubagentThreadForTest({
        ...subagentOptions,
        agentOptions: test.agent,
        toolResultStoreOptions: test.toolResultStoreOptions,
      }, request),
    compactHistory: async () => ({
      compacted: false,
      preTokenCount: 0,
      threshold: 0,
    }),
  };
  const runner = createHeadlessRunner({
    createResources: async (resourceOptions) => {
      const resources = test.createResources
        ? await test.createResources(resourceOptions)
        : await createRootRuntimeResourcesForTest({
            cwd: resourceOptions.configuration.cwd,
            workspaceBoundary:
              resourceOptions.configuration.workspaceBoundary,
            storage: resourceOptions.configuration.storage,
            settings: resourceOptions.configuration.settings,
            fileSources: resourceOptions.configuration.fileSources,
            ...(resourceOptions.signal ? {signal: resourceOptions.signal} : {}),
            ...(resourceOptions.headless !== undefined
              ? {headless: resourceOptions.headless}
              : {}),
            ...(resourceOptions.requestMcpApproval
              ? {requestMcpApproval: resourceOptions.requestMcpApproval}
              : {}),
            ...(resourceOptions.requestHookTrust
              ? {requestHookTrust: resourceOptions.requestHookTrust}
              : {}),
          }, {
            mcpManager: test.mcpManager,
            createLspManager: test.createLspManager,
            agentRuntime,
          });
      return {...resources, agentRuntime};
    },
    saveSession: test.saveSession ?? saveSessionSnapshot,
    writeOutput: test.writeOutput ?? writeHeadlessOutput,
    writeDiagnostic: test.writeDiagnostic ?? writeHeadlessDiagnostic,
  });

  return runner({
    ...options,
    storage: options.storage ?? createTestStorage(options.cwd),
  }, test.signal);
}
