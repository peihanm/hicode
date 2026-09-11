import type {ContextUsageTracker} from "../context/usage.js";
import {ApprovalBudget, ApprovalEpoch, type ApprovalReviewer} from "../permissions/approval.js";
import {randomUUID} from "node:crypto";
import type {FileCommitCoordinator} from "../tools/shared/fileCommit.js";
import type {CompactState} from "../context/index.js";
import type {McpManagerLike} from "../mcp/types.js";
import type {PermissionMode, PermissionPromptPolicy, PermissionRules,} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {LoadedSkill} from "../skills/types.js";
import type {ToolResultStore} from "../toolResults/index.js";
import type {Todo} from "../todos.js";
import type {ToolContext} from "../tools/types.js";
import type {TaskRuntimeLike, TaskSessionLike} from "../tasks/index.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {FileStateTracker} from "../tools/shared/fileState.js";
import {EMPTY_PROJECT_INSTRUCTIONS, type ProjectInstructions,} from "../prompt/instructions.js";
import type {HookSessionRuntime} from "../hooks/index.js";
import type {MemoryFileAccess} from "../memory/types.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {
    createDirectoryAccessRuntime,
    type DirectoryAccessRuntimeLike,
} from "../permissions/index.js";

export interface ToolContextResources {
    contextSettings: ToolContext["contextSettings"];
    allowFullAccess?: boolean;
    readOnlyTools?: boolean;
    approvalReviewer?: ApprovalReviewer;
    reviewerModel?: ToolContext["reviewerModel"];
    fileCommits: FileCommitCoordinator;
    storage: PillarStorageLayout;
    cwd: string;
    workspaceBoundary?: string;
    model: string;
    provider: LLMProviderName;
    fastModel: string;
    fastProvider: LLMProviderName;
    skills: LoadedSkill[];
    instructions?: ProjectInstructions;
    mcpManager?: McpManagerLike;
    taskRuntime?: TaskRuntimeLike;
    tasks?: TaskSessionLike;
    shellRunner: ShellRunnerLike;
    memoryFiles?: MemoryFileAccess;
}

export interface ToolContextSession {
    approvalEpoch?: ApprovalEpoch;
    fileState: FileStateTracker;
    networkAccess?: ToolContext["networkAccess"];
    sessionId: string;
    compactState: CompactState;
    contextUsage: ContextUsageTracker;
    toolResultStore: ToolResultStore;
    toolResultFiles?: ToolContext["toolResultFiles"];
    allowBackgroundTasks?: boolean;
    hookSession?: HookSessionRuntime;
    directoryAccess?: DirectoryAccessRuntimeLike;
}

export interface ToolContextHost {
    canUseTool: ToolContext["canUseTool"];

    getPermissionRules(): PermissionRules;

    getPermissionMode(): PermissionMode;

    getCollaborationMode(): CollaborationMode;

    getPermissionPromptPolicy(): PermissionPromptPolicy;

    setTodos(todos: Todo[]): void | Promise<void>;
}

export function createToolContext({
                                      signal,
                                      turnId,
                                      resources,
                                      session,
                                      host,
                                  }: {
    signal: AbortSignal;
    turnId?: string;
    resources: ToolContextResources;
    session: ToolContextSession;
    host: ToolContextHost;
}): ToolContext {
    return {
        signal,
        allowFullAccess: resources.allowFullAccess ?? false,
        readOnlyTools: resources.readOnlyTools ?? false,
        approvalEpoch: session.approvalEpoch ?? new ApprovalEpoch(),
        approvalBudget: new ApprovalBudget(),
        approvalReviewer: resources.approvalReviewer,
        reviewerModel: resources.reviewerModel,
        turnId: turnId ?? randomUUID(),
        canUseTool: host.canUseTool,
        get permissionRules() {
            return host.getPermissionRules();
        },
        get permissionMode() {
            return host.getPermissionMode();
        },
        get collaborationMode() {
            return host.getCollaborationMode();
        },
        get permissionPromptPolicy() {
            return host.getPermissionPromptPolicy();
        },
        setTodos: host.setTodos,
        skills: resources.skills,
        instructions: resources.instructions ?? EMPTY_PROJECT_INSTRUCTIONS,
        model: resources.model,
        provider: resources.provider,
        fastModel: resources.fastModel,
        fastProvider: resources.fastProvider,
        storage: resources.storage,
        cwd: resources.cwd,
        workspaceBoundary: resources.workspaceBoundary,
        compactState: session.compactState,
        contextUsage: session.contextUsage,
        contextSettings: resources.contextSettings,
        sessionId: session.sessionId,
        toolResultStore: session.toolResultStore,
        toolResultFiles: session.toolResultFiles ?? {
            resolveFile: path => session.toolResultStore.resolveFile(path),
        },
        fileState: session.fileState,
        fileCommits: resources.fileCommits,
        memoryFiles: resources.memoryFiles,
        networkAccess: session.networkAccess,
        directoryAccess: session.directoryAccess ?? createDirectoryAccessRuntime({
            cwd: resources.cwd,
            hardBoundary: resources.workspaceBoundary ?? resources.cwd,
            allowGrants: false,
        }),
        mcpManager: resources.mcpManager,
        tasks: resources.tasks ?? resources.taskRuntime?.forSession({
            sessionId: session.sessionId,
            toolResultStore: session.toolResultStore,
            allowBackgroundTasks: session.allowBackgroundTasks,
        }),
        ...(session.hookSession ? {hookSession: session.hookSession} : {}),
        shellRunner: resources.shellRunner,
    };
}
