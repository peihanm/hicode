import {ContextUsageTracker} from "../../src/context/usage.js";
import {FileCommitCoordinator} from "../../src/tools/shared/fileCommit.js";
import { createCompactState } from "../../src/context/index.js";
import type { PermissionDecision, PermissionMode } from "../../src/permissions/index.js";
import type {PermissionPromptPolicy} from "../../src/permissions/index.js";
import type {CollaborationMode} from "../../src/collaboration/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { MemoryFileAccess } from "../../src/memory/index.js";
import { createTestToolResultStore } from "./toolResultStore.js";
import type { ToolResultStore } from "../../src/toolResults/index.js";
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
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
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
import type {DirectoryAccessRuntimeLike} from "../../src/permissions/index.js";

export function createTestContext(
  cwd: string,
  options: {
    permissionMode?: PermissionMode;
    allowFullAccess?: boolean;
    readOnlyTools?: boolean;
    collaborationMode?: CollaborationMode;
    permissionPromptPolicy?: PermissionPromptPolicy;
    canUseTool?: ToolContext["canUseTool"];
    signal?: AbortSignal;
    sessionId?: string;
    toolResultStore?: ToolResultStore;
    tasks?: TaskSessionLike;
    mcpManager?: McpManagerLike;
    fileState?: FileStateTracker;
    fileCommits?: FileCommitCoordinator;
    instructions?: ProjectInstructions;
    shellRunner?: ShellRunnerLike;
    model?: string;
    provider?: LLMProviderName;
    fastModel?: string;
    fastProvider?: LLMProviderName;
    memoryFiles?: MemoryFileAccess;
    workspaceBoundary?: string;
    directoryAccess?: DirectoryAccessRuntimeLike;
    setTodos?: ToolContext["setTodos"];
  } = {}
): ToolContext & {setPermissionMode(mode: PermissionMode): void; setCollaborationMode(mode: CollaborationMode): void} {
  let permissionMode = options.permissionMode ?? "ask";
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
  const context = createToolContext({
    signal: options.signal ?? new AbortController().signal,
    resources: {
      allowFullAccess: options.allowFullAccess ?? true,
      readOnlyTools: options.readOnlyTools ?? false,
      fileCommits: options.fileCommits ?? new FileCommitCoordinator(),
      storage: createTestStorage(cwd),
      cwd,
      workspaceBoundary: options.workspaceBoundary,
      model: options.model ?? "glm-test",
      provider: options.provider ?? "glm",
      fastModel: options.fastModel ?? "glm-fast-test",
      fastProvider: options.fastProvider ?? "glm",
      skills: [],
      instructions: options.instructions ?? EMPTY_PROJECT_INSTRUCTIONS,
      tasks: options.tasks,
      mcpManager: options.mcpManager,
      gitSession,
      memoryFiles: options.memoryFiles,
      shellRunner:
        options.shellRunner ??
        createShellRunner(createDisabledSandboxRuntime(), testChildEnvironment),
    },
    session: {
      fileState: options.fileState ?? createFileStateTracker(),
      sessionId,
      compactState: createCompactState(), contextUsage: new ContextUsageTracker(),
      toolResultStore:
        options.toolResultStore ??
        createTestToolResultStore(cwd, sessionId),
      directoryAccess: options.directoryAccess,
    },
    host: {
      canUseTool: options.canUseTool ?? (async () => allow),
      getPermissionRules: () => permissionRules,
      getPermissionMode: () => permissionMode,
      getCollaborationMode: () => collaborationMode,
      getPermissionPromptPolicy: () =>
        options.permissionPromptPolicy ?? "onRequest",
      setTodos: options.setTodos ?? (() => {}),
    },
  });
  return Object.assign(context, {setPermissionMode(mode: PermissionMode) {context.approvalEpoch.invalidate(); permissionMode = mode;}, setCollaborationMode(mode: CollaborationMode) {context.approvalEpoch.invalidate(); collaborationMode = mode;}});
}
