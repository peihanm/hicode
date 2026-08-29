import type { RootRuntimeResources } from "../../src/runtime/resources.js";
import { createToolRuntime } from "../../src/tools/registry.js";
import type { TaskRuntimeLike } from "../../src/tasks/index.js";
import { createTaskRuntimeForTest } from "./taskRuntime.js";
import { createFileStateTracker } from "../../src/tools/shared/fileState.js";
import { EMPTY_PROJECT_INSTRUCTIONS } from "../../src/prompt/instructions.js";
import {
  createRootRuntimeResourcesFactory,
  type CreateRootRuntimeResourcesOptions,
} from "../../src/runtime/resources.js";
import type { CreateLspManager } from "../../src/lsp/types.js";
import type { McpManagerLike } from "../../src/mcp/types.js";
import type { LoadedSkill } from "../../src/skills/types.js";
import type { ProjectInstructions } from "../../src/prompt/instructions.js";
import type { ToolRuntime } from "../../src/tools/registry.js";
import type { FileStateTracker } from "../../src/tools/shared/fileState.js";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "../../src/runtime/agentRuntime.js";
import type { ResolvedPillarSettings } from "../../src/settings/index.js";
import {
  createAgentDefinitionManager,
  createAgentDefinitionStore,
  createSubagentCatalog,
  type SubagentCatalog,
  type SubagentRegistry,
} from "../../src/subagents/index.js";
import type { LoadedCustomAgents } from "../../src/subagents/index.js";
import { createEmptyResolvedHookSettings } from "../../src/hooks/index.js";
import type { HookRuntime } from "../../src/hooks/types.js";
import {
  createMemoryRuntime,
  type MemoryRuntimeLike,
} from "../../src/memory/index.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import { createShellRunner } from "../../src/tools/bash/shellRunner.js";
import { createGitWorkspaceRuntime } from "../../src/git/index.js";

export function createTestSettings(
  overrides: Partial<ResolvedPillarSettings> = {}
): ResolvedPillarSettings {
  return {
    models: {
      primary: {model: "glm-test", provider: "glm"},
      fast: {model: "glm-fast-test", provider: "glm"},
    },
    permissions: {
      defaultMode: "default",
      rules: { allow: [], ask: [], deny: [] },
    },
    hooks: createEmptyResolvedHookSettings(),
    memory: { enabled: false, autoExtract: false },
    checkpointing: { enabled: false },
    sandbox: {
      enabled: false,
      filesystem: {
        allowWrite: ["."],
        denyRead: ["~/.ssh", "~/.aws", "~/.config/gcloud"],
        denyWrite: [".pillar", ".env"],
      },
      network: { allowedDomains: [], allowLocalBinding: false },
    },
    ...overrides,
  };
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
  const shellRunner = createShellRunner(sandbox);
  const settings = overrides.settings ?? createTestSettings();
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
      cwd,
      model: settings.models.primary.model,
      provider: settings.models.primary.provider,
      shellRunner,
      settings: settings.memory,
    });
  const agentRuntime =
    overrides.agentRuntime ??
    createAgentRuntime({models: settings.models, subagents, memory});
  const taskRuntime = createTaskRuntimeForTest(
    cwd,
    shellRunner,
    agentRuntime.createSubagentRunner
  );
  const hooks = overrides.hooks ?? createDisabledTestHookRuntime();
  const toolRuntime = overrides.toolRuntime ?? createToolRuntime({hooks});
  const agentDefinitions = overrides.agentDefinitions ??
    createAgentDefinitionManager({
      store: createAgentDefinitionStore(cwd),
      catalog: subagents,
      availableToolNames: toolRuntime.toolNames,
    });
  const agentAuthoring = overrides.agentAuthoring ?? {
    async generate(): Promise<never> {
      throw new Error("测试 Runtime 未配置 Agent 生成响应");
    },
  };
  const base: RootRuntimeResources = {
    cwd,
    model: settings.models.primary.model,
    fastModel: settings.models.fast.model,
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
    fileState: createFileStateTracker(),
    memory,
    gitWorkspace: createGitWorkspaceRuntime(cwd),
    async close() {
      await taskRuntime.close();
      await sandbox.close();
    },
  };
  return {
    ...base,
    ...overrides,
    settings,
    agentRuntime,
    subagents,
    agentDefinitions,
    agentAuthoring,
  };
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
    mayRunCommands: false,
    issues: [],
    async execute() {
      return {blocked: false, additionalContexts: [], executions: []};
    },
  };
}

interface RootRuntimeTestDependencies {
  mcpManager?: McpManagerLike | false;
  createLspManager?: CreateLspManager;
  loadSkills?: (cwd: string) => LoadedSkill[];
  loadProjectInstructions?: (cwd: string) => Promise<ProjectInstructions>;
  createToolRuntime?: () => ToolRuntime;
  taskRuntime?: TaskRuntimeLike;
  fileState?: FileStateTracker;
  agentRuntime?: AgentRuntime;
  memory?: MemoryRuntimeLike;
  loadedCustomAgents?: LoadedCustomAgents;
}

export function createRootRuntimeResourcesForTest(
  options: CreateRootRuntimeResourcesOptions,
  test: RootRuntimeTestDependencies = {}
) {
  return createRootRuntimeResourcesFactory({
    ...(test.mcpManager === undefined
      ? {}
      : {
          createMcpManager: () =>
            test.mcpManager === false ? undefined : test.mcpManager,
        }),
    ...(test.createLspManager
      ? { createLspManager: test.createLspManager }
      : {}),
    ...(test.loadSkills ? { loadSkills: test.loadSkills } : {}),
    ...(test.loadProjectInstructions
      ? { loadProjectInstructions: test.loadProjectInstructions }
      : {}),
    ...(test.createToolRuntime
      ? { createToolRuntime: test.createToolRuntime }
      : {}),
    ...(test.taskRuntime
      ? { createTaskRuntime: () => test.taskRuntime! }
      : {}),
    ...(test.fileState
      ? { createFileStateTracker: () => test.fileState! }
      : {}),
    ...(test.agentRuntime
      ? { createAgentRuntime: () => test.agentRuntime! }
      : {}),
    ...(test.memory
      ? { createMemoryRuntime: () => test.memory! }
      : {}),
    loadCustomAgentDefinitions: async () =>
      test.loadedCustomAgents ?? { definitions: [], issues: [] },
    createHookRuntime: async () => createDisabledTestHookRuntime(),
  })(options);
}
