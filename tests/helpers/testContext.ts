import { createCompactState } from "../../src/context/index.js";
import type { PermissionDecision, PermissionMode } from "../../src/permissions/index.js";
import type {PermissionPromptPolicy} from "../../src/permissions/index.js";
import type {CollaborationMode} from "../../src/collaboration/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { MemoryFileAccess } from "../../src/memory/index.js";
import { createTestToolResultStore } from "./toolResultStore.js";
import type { ToolResultStore } from "../../src/toolResults/index.js";
import type { LspManagerLike } from "../../src/lsp/types.js";
import { createToolContext } from "../../src/runtime/toolContext.js";
import type { TaskSessionLike } from "../../src/tasks/index.js";
import type { McpManagerLike } from "../../src/mcp/types.js";
import {
  createFileStateTracker,
  type FileStateTracker,
} from "../../src/tools/shared/fileState.js";
import {
  EMPTY_PROJECT_INSTRUCTIONS,
  type ProjectInstructions,
} from "../../src/prompt/instructions.js";
import { createDisabledFileCheckpointRuntime } from "../../src/checkpoints/index.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import {
  createShellRunner,
  type ShellRunnerLike,
} from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "./childEnvironment.js";
import {
  createGitSessionRuntime,
  createGitWorkspaceRuntime,
} from "../../src/git/index.js";
import {createTestStorage} from "./tempProject.js";
import type { LLMProviderName } from "../../src/llm/providerRegistry.js";

export function createTestContext(
  cwd: string,
  options: {
    permissionMode?: PermissionMode;
    collaborationMode?: CollaborationMode;
    permissionPromptPolicy?: PermissionPromptPolicy;
    canUseTool?: ToolContext["canUseTool"];
    signal?: AbortSignal;
    sessionId?: string;
    toolResultStore?: ToolResultStore;
    lspManager?: LspManagerLike;
    tasks?: TaskSessionLike;
    mcpManager?: McpManagerLike;
    fileState?: FileStateTracker;
    instructions?: ProjectInstructions;
    shellRunner?: ShellRunnerLike;
    model?: string;
    provider?: LLMProviderName;
    fastModel?: string;
    fastProvider?: LLMProviderName;
    memoryFiles?: MemoryFileAccess;
    workspaceBoundary?: string;
    setTodos?: ToolContext["setTodos"];
  } = {}
): ToolContext {
  let permissionMode = options.permissionMode ?? "bypassPermissions";
  let collaborationMode = options.collaborationMode ?? "build";

  const allow: PermissionDecision = { behavior: "allow" };

  const permissionRules = { allow: [], ask: [], deny: [] };
  const sessionId = options.sessionId ?? "test-session";
  const gitWorkspace = createGitWorkspaceRuntime(cwd, testChildEnvironment);
  const gitSession = createGitSessionRuntime({
    cwd,
    workspace: gitWorkspace,
    resumed: false,
  });
  return createToolContext({
    signal: options.signal ?? new AbortController().signal,
    resources: {
      storage: createTestStorage(cwd),
      cwd,
      workspaceBoundary: options.workspaceBoundary,
      model: options.model ?? "glm-test",
      provider: options.provider ?? "glm",
      fastModel: options.fastModel ?? "glm-fast-test",
      fastProvider: options.fastProvider ?? "glm",
      skills: [],
      instructions: options.instructions ?? EMPTY_PROJECT_INSTRUCTIONS,
      lspManager: options.lspManager,
      tasks: options.tasks,
      mcpManager: options.mcpManager,
      fileState: options.fileState ?? createFileStateTracker(),
      gitSession,
      memoryFiles: options.memoryFiles,
      shellRunner:
        options.shellRunner ??
        createShellRunner(createDisabledSandboxRuntime(), testChildEnvironment),
    },
    session: {
      sessionId,
      compactState: createCompactState(),
      toolResultStore:
        options.toolResultStore ??
        createTestToolResultStore(cwd, sessionId),
      fileCheckpoints: createDisabledFileCheckpointRuntime(),
    },
    host: {
      canUseTool: options.canUseTool ?? (async () => allow),
      getPermissionRules: () => permissionRules,
      getPermissionMode: () => permissionMode,
      getCollaborationMode: () => collaborationMode,
      getPermissionPromptPolicy: () =>
        options.permissionPromptPolicy ?? "onRequest",
      setPermissionMode(mode) {
        permissionMode = mode;
      },
      setCollaborationMode(mode) {
        collaborationMode = mode;
      },
      setTodos: options.setTodos ?? (() => {}),
    },
  });
}
