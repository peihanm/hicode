import {FileCommitCoordinator} from "../../src/checkpoints/fileCommit.js";
import type { RootRuntimeResources } from "../../src/runtime/resources.js";
import { createToolRuntime } from "../../src/tools/registry.js";
import type { TaskRuntimeLike } from "../../src/tasks/index.js";
import { createTaskRuntimeForTest } from "./taskRuntime.js";
import { EMPTY_PROJECT_INSTRUCTIONS } from "../../src/prompt/instructions.js";
import {
  createRootRuntimeResourcesFactory,
  type CreateRootRuntimeResourcesOptions,
} from "../../src/runtime/resources.js";
import type { McpManagerLike } from "../../src/mcp/types.js";
import type { LoadedSkill } from "../../src/skills/types.js";
import type { ProjectInstructions } from "../../src/prompt/instructions.js";
import type { ToolRuntime } from "../../src/tools/registry.js";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "../../src/runtime/agentRuntime.js";
import type { ResolvedPillarSettings } from "../../src/settings/index.js";
import { resolvePillarSettings } from "../../src/settings/index.js";
import {
  createAgentDefinitionManager,
  createAgentDefinitionStore,
  createSubagentCatalog,
  type SubagentCatalog,
  type SubagentRegistry,
} from "../../src/subagents/index.js";
import type { LoadedCustomAgents } from "../../src/subagents/index.js";
import { createEmptyResolvedHookSettings } from "./hooks.js";
import type { HookRuntime } from "../../src/hooks/types.js";
import {
  createMemoryRuntime,
  type MemoryRuntimeLike,
} from "../../src/memory/index.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import { createShellRunner } from "../../src/tools/bash/shellRunner.js";
import { createGitWorkspaceRuntime } from "../../src/git/index.js";
import { createPrimaryModelRuntime } from "../../src/runtime/primaryModel.js";
import {testChildEnvironment} from "./childEnvironment.js";
import {createTestStorage} from "./tempProject.js";
import {createInputHistoryStore} from "../../src/session/inputHistory/index.js";
import {
  CLI_FILE_SOURCES,
  createPillarRootConfiguration,
  type PillarFileSources,
  type PillarRootConfiguration,
  type PillarRootContributions,
} from "../../src/runtime/rootConfiguration.js";

export function createTestSettings(
  overrides: Partial<ResolvedPillarSettings> = {}
): ResolvedPillarSettings {
  const defaultSources = resolvePillarSettings([]).values.sources;
  return {
    sources: {
      ...defaultSources,
      glm: {
        ...defaultSources.glm,
        models: [
          {id: "glm-test", label: "GLM Test"},
          {id: "glm-fast-test", label: "GLM Fast Test"},
        ],
      },
    },
    models: {
      primary: {
        source: "glm",
        provider: "glm",
        model: "glm-test",
        label: "GLM Test",
      },
      fast: {
        source: "glm",
        provider: "glm",
        model: "glm-fast-test",
        label: "GLM Fast Test",
      },
    },
    permissions: {
      defaultMode: "default",
      additionalDirectories: [],
      rules: { allow: [], ask: [], deny: [] },
    },
    hooks: createEmptyResolvedHookSettings(),
    memory: { enabled: false, autoExtract: false },
    checkpointing: { enabled: false },
    sandbox: {
      enabled: false,
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.config/gcloud"],
        denyWrite: [".pillar", ".env"],
      },
      network: { allowedDomains: [], allowLocalBinding: true },
    },
    ...overrides,
  };
}

export function createTestRootConfiguration(
  cwd: string,
  settings: ResolvedPillarSettings = createTestSettings(),
  storage = createTestStorage(cwd),
  fileSources: PillarFileSources = CLI_FILE_SOURCES
): PillarRootConfiguration {
  return createPillarRootConfiguration({
    cwd,
    workspaceBoundary: cwd,
    storage,
    settings,
    fileSources,
  });
}

type TestRuntimeResourceOverrides = Partial<
  Omit<RootRuntimeResources, "subagents">
> & {
  subagents?: SubagentRegistry;
};

export function createTestRuntimeResources(
  cwd: string,
  overrides: TestRuntimeResourceOverrides = {}
): RootRuntimeResources {
  const sandbox = createDisabledSandboxRuntime();
  const shellRunner = createShellRunner(sandbox, testChildEnvironment);
  const settings = overrides.settings ?? createTestSettings();
  const storage = overrides.storage ?? createTestStorage(cwd);
  const primaryModel = overrides.primaryModel ?? createPrimaryModelRuntime(
    settings.models.primary,
    settings.sources,
    [settings.models.primary]
  );
  const defaultCatalog = createSubagentCatalog({
    load: async () => ({definitions: [], issues: []}),
  });
  const providedSubagents = overrides.subagents ?? defaultCatalog;
  const subagents = "reload" in providedSubagents
    ? providedSubagents as SubagentCatalog
    : createStaticTestCatalog(providedSubagents);
  const memory =
    overrides.memory ??
    createMemoryRuntime({
      storage,
      cwd,
      getModelTarget: () => primaryModel.target,
      getModelSource: (source) => settings.sources[source],
      shellRunner,
      settings: settings.memory,
    });
  const agentRuntime =
    overrides.agentRuntime ??
    createAgentRuntime({
      storage,
      fastModel: settings.models.fast,
      sources: settings.sources,
      subagents,
      memory,
    });
  const taskRuntime = createTaskRuntimeForTest(
    cwd,
    shellRunner,
    agentRuntime.createSubagentThread
  );
  const hooks = overrides.hooks ?? createDisabledTestHookRuntime();
  const toolRuntime = overrides.toolRuntime ?? createToolRuntime({hooks});
  const agentDefinitions = overrides.agentDefinitions ??
    createAgentDefinitionManager({
      store: createAgentDefinitionStore(storage, cwd),
      catalog: subagents,
      availableToolNames: toolRuntime.toolNames,
    });
  const agentAuthoring = overrides.agentAuthoring ?? {
    async generate(): Promise<never> {
      throw new Error("测试 Runtime 未配置 Agent 生成响应");
    },
  };
  let taskClosePromise: Promise<void> | undefined;
  const beginShutdown = () => {
    taskClosePromise ??= Promise.resolve()
      .then(() => taskRuntime.close())
      .catch(() => undefined);
  };
  const base: RootRuntimeResources = {
    storage,
    inputHistory: createInputHistoryStore(storage),
    cwd,
    workspaceBoundary: overrides.workspaceBoundary ?? cwd,
    get model() {
      return primaryModel.target.model;
    },
    get provider() {
      return primaryModel.target.provider;
    },
    fastModel: settings.models.fast.model,
    fastProvider: settings.models.fast.provider,
    primaryModel,
    settings,
    agentRuntime,
    subagents,
    agentDefinitions,
    agentAuthoring,
    skills: [],
    instructions: EMPTY_PROJECT_INSTRUCTIONS,
    toolRuntime,
    hooks,
    taskRuntime,
    shellRunner,
    sandbox,
    memory,
    fileCommits: new FileCommitCoordinator(),
    gitWorkspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
    beginShutdown,
    async close() {
      beginShutdown();
      await taskClosePromise;
      await sandbox.close();
    },
  };
  const result = {
    ...base,
    ...overrides,
    settings,
    agentRuntime,
    subagents,
    agentDefinitions,
    agentAuthoring,
  };
  Object.defineProperties(result, {
    model: {get: () => primaryModel.target.model, enumerable: true},
    provider: {get: () => primaryModel.target.provider, enumerable: true},
  });
  return result;
}

function createStaticTestCatalog(registry: SubagentRegistry): SubagentCatalog {
  return {
    revision: 1,
    issues: registry.issues,
    listDefinitions: () => registry.listDefinitions(),
    has: (name) => registry.has(name),
    get: (name) => registry.get(name),
    async reload() {
      return {
        revision: 1,
        added: [],
        updated: [],
        removed: [],
        issues: registry.issues,
      };
    },
  };
}

function createDisabledTestHookRuntime(): HookRuntime {
  return {
    enabled: false,
    issues: [],
    async execute() {
      return {blocked: false, additionalContexts: [], executions: []};
    },
  };
}

interface RootRuntimeTestDependencies {
  mcpManager?: McpManagerLike | false;
  loadSkills?: (cwd: string) => LoadedSkill[];
  loadProjectInstructions?: (cwd: string) => Promise<ProjectInstructions>;
  createToolRuntime?: () => ToolRuntime;
  taskRuntime?: TaskRuntimeLike;
  agentRuntime?: AgentRuntime;
  memory?: MemoryRuntimeLike;
  loadedCustomAgents?: LoadedCustomAgents;
}

export function createRootRuntimeResourcesForTest(
  options: Omit<CreateRootRuntimeResourcesOptions, "configuration"> & {
    cwd: string;
    settings: ResolvedPillarSettings;
    storage?: RootRuntimeResources["storage"];
    workspaceBoundary?: string;
    fileSources?: PillarFileSources;
    rootContributions?: PillarRootContributions;
  },
  test: RootRuntimeTestDependencies = {}
) {
  return createRootRuntimeResourcesFactory({
    ...(test.mcpManager === undefined
      ? {}
      : {
          createMcpManager: () =>
            test.mcpManager === false ? undefined : test.mcpManager,
        }),
    ...(test.loadSkills
      ? {loadSkills: ({cwd}: {cwd: string}) => test.loadSkills!(cwd)}
      : {}),
    ...(test.loadProjectInstructions
      ? {
          loadProjectInstructions: ({cwd}: {cwd: string}) =>
            test.loadProjectInstructions!(cwd),
        }
      : {}),
    ...(test.createToolRuntime
      ? { createToolRuntime: test.createToolRuntime }
      : {}),
    ...(test.taskRuntime
      ? { createTaskRuntime: () => test.taskRuntime! }
      : {}),
    ...(test.agentRuntime
      ? { createAgentRuntime: () => test.agentRuntime! }
      : {}),
    ...(test.memory
      ? { createMemoryRuntime: () => test.memory! }
      : {}),
    ...(test.loadedCustomAgents
      ? {loadCustomAgentDefinitions: async () => test.loadedCustomAgents!}
      : {}),
    createHookRuntime: async () => createDisabledTestHookRuntime(),
  })({
    configuration: createPillarRootConfiguration({
      cwd: options.cwd,
      workspaceBoundary: options.workspaceBoundary ?? options.cwd,
      storage: options.storage ?? createTestStorage(options.cwd),
      settings: options.settings,
      fileSources: options.fileSources ?? CLI_FILE_SOURCES,
      rootContributions: options.rootContributions,
    }),
    ...(options.signal ? {signal: options.signal} : {}),
    ...(options.headless !== undefined ? {headless: options.headless} : {}),
    ...(options.requestMcpApproval
      ? {requestMcpApproval: options.requestMcpApproval}
      : {}),
    ...(options.requestHookTrust
      ? {requestHookTrust: options.requestHookTrust}
      : {}),
  });
}
