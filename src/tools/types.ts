import type {ContextUsageTracker} from "../context/usage.js";
import type {ImageAccess} from "../images/access.js";
import type {FileCommitCoordinator} from "./shared/fileCommit.js";
import {z} from "zod";
import type {PermissionDecision, PermissionMode, PermissionPromptPolicy, PermissionPromptPresentation, PermissionResult, PermissionRules,} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {Todo} from "../todos.js";
import type {LoadedSkill} from "../skills/types.js";
import type {CompactState} from "../context/index.js";
import type {ToolOutput, ToolResultStore} from "../toolResults/index.js";
import type {SubagentLauncher} from "../subagents/launcher.js";
import type {McpManagerLike} from "../mcp/types.js";
import type {TaskSessionLike} from "../tasks/index.js";
import type {ShellRunnerLike} from "./bash/shellRunner.js";
import type {FileStateTracker} from "./shared/fileState.js";
import type {ProjectInstructions} from "../prompt/instructions.js";
import type {HookSessionRuntime, HookInput, HookBatchResult, HookLifecycleEvent, HookRuntime} from "../hooks/index.js";
import type {MemoryFileAccess} from "../memory/types.js";
import type {SessionArchiveAccess} from "../session/archiveAccess.js";
import type {SessionCompaction} from "../session/archive.js";
import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {DirectoryAccessRuntimeLike} from "../permissions/directoryAccess.js";
import type {NetworkAccessSession} from "../permissions/networkAccess.js";
import type {ApprovalBudget, ApprovalEpoch, ApprovalEvent, ApprovalReviewer} from "../permissions/approval.js";
import type {Message} from "../llm/types.js";
import type {ContextSettings} from "../context/config.js";
import type {ModelTargetSettings} from "../settings/types.js";

export type PermissionRuleBehavior = "allow" | "ask" | "deny";
export type PermissionMatcher = (
    pattern: string,
    behavior: PermissionRuleBehavior
) => boolean;

export type ToolExposure = "direct" | "deferred";
export type DefaultApprovalScope =
    | {kind: "workspace"; path: string}
    | {kind: "sandboxed"};

interface ToolSearchSource {
    name: string;
    description?: string;
}

// Tool runtime context injects permission decisions, rules, modes and other dependencies.
// Tools do not depend directly on UI or configuration loading.
export interface ToolContext {
    llmTrace?: import("../llm/types.js").LLMTrace;
    readonly toolNames: readonly string[];
    imageModelSupported?: boolean;
    imageAccess?: ImageAccess;
    /** Root Turn observes actual execute intervals, excluding permission and batch queues. */
    storage: PillarStorageLayout;
    // Cancellation signal for this Turn; create a fresh signal for each Turn.
    signal: AbortSignal;

    // Called when tool checkPermissions returns ask.
    // Returns allow/deny; the caller owns the dialog.
    // toolName and input generate allow rules for "don't ask again".
    canUseTool: (
        tool: string,
        message: string,
        input: unknown,
        options?: {
            allowPersistent?: boolean;
            presentation?: PermissionPromptPresentation;
            signal?: AbortSignal;
        }
    ) => Promise<PermissionDecision>;

    // Configuration permission rules, grouped by allow/ask/deny.
    permissionRules: PermissionRules;

    // Host-selected execution permission preset; the model cannot change it.
    readonly permissionMode: PermissionMode;
    readonly allowFullAccess: boolean;
    readonly readOnlyTools: boolean;
    readonly approvalEpoch: ApprovalEpoch;
    readonly approvalBudget: ApprovalBudget;
    approvalReviewer?: ApprovalReviewer;
    reviewerModel?: ModelTargetSettings;
    approvalEvidence?: () => readonly Message[];
    onApprovalEvent?: (event: ApprovalEvent) => void | Promise<void>;

    // Build/Plan is independent of permission profiles; Plan narrows capabilities without changing permissionMode.
    readonly collaborationMode: CollaborationMode;

    // A non-interactive Host narrows ask to deny; this is not a user permission profile.
    permissionPromptPolicy: PermissionPromptPolicy;

    // TodoWrite updates React state through this callback to drive TodoList.
    setTodos: (todos: Todo[]) => void | Promise<void>;

    // Skills loaded at startup for the Skill tool.
    skills: LoadedSkill[];
    instructions: ProjectInstructions;

    // Current model name for environment and context-window calculations.
    model: string;

    // Provider for the current main model, frozen per Turn; switching cannot alter an active Turn.
    provider: LLMProviderName;

    // Configured fast model for Agent descriptions and model=fast routing.
    fastModel: string;

    fastProvider: LLMProviderName;

    // Working directory for tool paths, attachments and project identity.
    cwd: string;

    // Enforced child Agent file boundary; unset by default for Root.
    workspaceBoundary?: string;

    // Directories authorized for this Session; cannot override Host/child hard boundaries.
    directoryAccess: DirectoryAccessRuntimeLike;
    networkAccess?: NetworkAccessSession;

    // Root-only file-based Memory capability; children must not inherit it.
    memoryFiles?: MemoryFileAccess;

    // Session Auto-Compact state: failure breaker and counters.
    compactState: CompactState;
    readonly contextSettings: ContextSettings;
    contextUsage: ContextUsageTracker;

    // Session large-result storage, injected by UI, Headless or tests.
    sessionId: string;
    toolResultStore: ToolResultStore;
    toolResultFiles: Pick<ToolResultStore, "resolveFile">;
    sessionArchives?: SessionArchiveAccess;
    sessionCompaction?: SessionCompaction;
    /** Root Session only: commit complete paired batches before the next model request. */
    commitToolBatch?: () => Promise<void>;

    // Session file observations for Read/Edit/Write stale-version
    // and partial-read checks; never replace with process-global state.
    fileState: FileStateTracker;
    fileCommits: FileCommitCoordinator;


    // Session Git baseline and provenance hints wrap gitWorkspace;
    // state persists with the Session snapshot, not a Root process global.

    // Root Turn injects the shared launcher; child contexts omit it to prevent recursion.
    subagentLauncher?: SubagentLauncher;

    // Root MCP state for /mcp and child capability narrowing.
    // Custom children filter tools by definition and do not inherit the manager.
    mcpManager?: McpManagerLike;

    // Session task view; Root owns task state and children do not inherit it by default.
    tasks?: TaskSessionLike;

    // Session Hook lifecycle state for atomic once claims.
    // Session Runtime owns this state, not Root Hook Runtime.
    hookSession?: HookSessionRuntime;
    turnId: string;
    holdHookConfiguration?: () => () => void;
    onHookEvent?: (event: HookLifecycleEvent) => void | Promise<void>;
    runHook?: (input: HookInput, signal?: AbortSignal) => Promise<HookBatchResult>;
    hookControl?: {inspect: HookRuntime["inspect"]; reload(signal: AbortSignal): Promise<void>};

    // Root owns the shared Shell execution boundary. Foreground, background and child Agents
    // use the same Runner for consistent Sandbox, cancellation and output semantics.
    shellRunner: ShellRunnerLike;
}

interface ToolInvocation {
    permissionApproved?: true;
    toolCallId: string;
    userAnswers?: Readonly<Record<string, string>>;
}

// Tool contract: name, description, Zod input schema, permission declaration and execution.
// One Zod schema generates model JSON Schema and validates runtime arguments.
export interface Tool<T extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    /** Runtime-dependent model guidance, such as a hot-reloaded Agent Catalog. */
    getDescription?(): string;
    parameters: T; // Zod schema

    // Whether full Schema appears in the first model request; defaults to direct.
    // Deferred loading affects visibility only, not permissions, concurrency or execution capabilities.
    exposure?: ToolExposure;

    // Additional search terms and source summary. External text is for discovery, never permission decisions.
    searchHint?: string;
    searchSource?: ToolSearchSource;

    // External tools, currently MCP, may provide JSON Schema directly.
    // Built-ins omit this field and derive JSON Schema from Zod.
    inputJsonSchema?: Record<string, unknown>;


    // Permission intent returns allow/deny/ask/passthrough.
    // Defaults to passthrough; executeTool decides using isReadOnly.
    checkPermissions?(
        input: z.infer<T>,
        ctx: ToolContext
    ): Promise<PermissionResult>;

    // Matcher factory for permission rules.
    // Converts input into a string that can match rule patterns.
    // Default: JSON.stringify(input).
    // Bash splits subcommands and uses different allow/ask/deny strategies.
    preparePermissionMatcher?(
        input: z.infer<T>
    ): Promise<PermissionMatcher>;

    // Metadata used by default permission rules.
    // isReadOnly defaults to false, meaning a write operation.
    isReadOnly?(input: z.infer<T>): boolean;

    // Whether this tool may run concurrently with adjacent safe tools in one assistant message.
    // Must be explicit: read-only does not imply concurrency safety, e.g. ask_user/todo_write.
    isConcurrencySafe?(input: z.infer<T>): boolean;

    // Ordinary allow rules cannot silently approve these actions; use the reviewer or Full Access preauthorization.
    // ask_user answers still come only from the Host.
    requiresExplicitApproval?(input: z.infer<T>, ctx: ToolContext): boolean;

    // Host answers arrive through invocation, not model parameters, and cannot replace original questions.
    acceptsUserAnswers?: boolean;

    // Default approval requires a provable side-effect scope. Workspace paths still undergo
    // canonical validation by the permission resolver. Only an execution boundary that knows
    // the OS Sandbox is ready may declare sandboxed. Omission means unknown scope.
    getDefaultApprovalScope?(
        input: z.infer<T>,
        ctx: ToolContext
    ): DefaultApprovalScope | undefined;

    // Model-visible results above this character limit enter Tool Result Store.
    // Infinity means the tool already bounds output; do not recursively persist it.
    maxResultSizeChars?: number;

    // Execution occurs only after permission approval; no additional confirm call is needed.
    execute(
        args: z.infer<T>,
        ctx: ToolContext,
        invocation: ToolInvocation
    ): Promise<ToolOutput>;
}
