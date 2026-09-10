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
import type { McpManagerLike } from "../../src/mcp/index.js";
import { createRootRuntimeResources } from "../../src/runtime/resources.js";
import type {RootSessionSnapshotWriter} from "../../src/runtime/turnRuntime.js";
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
import type {ResolvedPillarSettings} from "../../src/settings/index.js";
import type {PillarStorageLayout} from "../../src/persistence/index.js";
import {
  CLI_FILE_SOURCES,
  createPillarRootConfiguration,
} from "../../src/runtime/rootConfiguration.js";
import {parse} from "node:path";
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
  createResources?: typeof createRootRuntimeResources;
  runAgent?: AgentRunner;
  saveSession?: RootSessionSnapshotWriter;
}

export type HeadlessTestInput = Omit<HeadlessOptions, "configuration"> & {
  cwd: string;
  settings: ResolvedPillarSettings;
  storage?: PillarStorageLayout;
};

export function runHeadlessForTest(
  options: HeadlessTestInput,
  test: HeadlessTestOptions = {}
): Promise<HeadlessRunSummary> {
  const agentRuntime: AgentRuntime = {
    reviewApproval: async () => ({decision: "needs_user", risk: "medium", reason: "test reviewer not configured"}),
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
            agentRuntime,
          });
      return {...resources, agentRuntime};
    },
    saveSession: test.saveSession ?? ((session, snapshot) => session.saveSnapshot(snapshot)),
    writeOutput: test.writeOutput ?? writeHeadlessOutput,
    writeDiagnostic: test.writeDiagnostic ?? writeHeadlessDiagnostic,
  });

  const storage = options.storage ?? createTestStorage(options.cwd);
  const configuration = createPillarRootConfiguration({
    allowFullAccess: true,
    cwd: options.cwd,
    workspaceBoundary: parse(options.cwd).root,
    storage,
    settings: options.settings,
    fileSources: CLI_FILE_SOURCES,
  });
  return runner({
    configuration,
    prompt: options.prompt,
    images: options.images,
    permissionMode: options.permissionMode,
    collaborationMode: options.collaborationMode,
    resumeMode: options.resumeMode,
    outputFormat: options.outputFormat,
  }, test.signal);
}
