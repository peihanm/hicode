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

// 工具运行时上下文：注入权限裁决、规则、模式等依赖
// 避免工具直接耦合 UI / 配置加载
export interface ToolContext {
    imageModelSupported?: boolean;
    imageAccess?: ImageAccess;
    /** Root Turn observes actual execute intervals, excluding permission and batch queues. */
    storage: PillarStorageLayout;
    // 当前 turn 的取消信号。每轮必须创建新的 signal，不能复用已取消 signal。
    signal: AbortSignal;

    // 权限裁决：当工具 checkPermissions 返回 ask 时调用
    // 返回 allow/deny，由调用方（App.tsx）实现弹窗
    // toolName + input 用于 "don't ask again" 时生成 allow 规则
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

    // 配置文件加载的权限规则（allow/ask/deny 三桶）
    permissionRules: PermissionRules;

    // 执行权限预设；由 Host 选择，不向模型暴露修改入口。
    readonly permissionMode: PermissionMode;
    readonly allowFullAccess: boolean;
    readonly readOnlyTools: boolean;
    readonly approvalEpoch: ApprovalEpoch;
    readonly approvalBudget: ApprovalBudget;
    approvalReviewer?: ApprovalReviewer;
    reviewerModel?: ModelTargetSettings;
    approvalEvidence?: () => readonly Message[];
    onApprovalEvent?: (event: ApprovalEvent) => void | Promise<void>;

    // Build/Plan 与权限 Profile 独立；Plan 只收窄能力，不改变 permissionMode。
    readonly collaborationMode: CollaborationMode;

    // 非交互 Host 把 ask 收窄为 deny；它不是用户权限 Profile。
    permissionPromptPolicy: PermissionPromptPolicy;

    // TodoWrite 工具用：更新 React state 驱动 TodoList UI
    setTodos: (todos: Todo[]) => void | Promise<void>;

    // Skill 工具用：启动时加载的 skill 列表
    skills: LoadedSkill[];
    instructions: ProjectInstructions;

    // 当前模型名（env 探测 + context window 判断用）
    model: string;

    // 当前主模型对应的 Provider。每个 Turn 固化一次，运行中切换不会改变旧 Turn。
    provider: LLMProviderName;

    // 当前 Runtime 配置的快速模型名（Agent 描述与 model=fast 路由说明用）
    fastModel: string;

    fastProvider: LLMProviderName;

    // 当前工作目录（工具路径解析、attachment 探测与项目 identity 用）
    cwd: string;

    // Worktree Agent 的执行层文件边界；Root Runtime 默认不设置。
    workspaceBoundary?: string;

    // 当前 Session 已授权的工作目录；不能替代 Host/子 Agent hard boundary。
    directoryAccess: DirectoryAccessRuntimeLike;
    networkAccess?: NetworkAccessSession;

    // Root-only 文件式 Memory capability。子 Agent 不得继承。
    memoryFiles?: MemoryFileAccess;

    // Auto-Compact 会话状态（失败熔断 / 次数统计）
    compactState: CompactState;
    readonly contextSettings: ContextSettings;
    contextUsage: ContextUsageTracker;

    // 当前 Session 的大工具结果存储。由 UI / Headless / tests 注入。
    sessionId: string;
    toolResultStore: ToolResultStore;
    toolResultFiles: Pick<ToolResultStore, "resolveFile">;
    sessionArchives?: SessionArchiveAccess;
    sessionCompaction?: SessionCompaction;
    /** Root Session only: commit complete paired batches before the next model request. */
    commitToolBatch?: () => Promise<void>;

    // Session 级的文件观测状态，供 Read/Edit/Write 做 stale
    // 和部分读取范围检查。不得使用进程级全局状态代替。
    fileState: FileStateTracker;
    fileCommits: FileCommitCoordinator;


    // 当前 Session 的 Git Baseline 与来源提示。它包装 gitWorkspace，
    // 但状态随 Session Snapshot 持久化，不能做成 Root 进程级全局。

    // Root turn 注入统一子 Agent launcher；子 Agent context 不注入，阻止递归。
    subagentLauncher?: SubagentLauncher;

    // Root runtime 的 MCP 状态；供 /mcp 和子 Agent 能力收窄读取。
    // 自定义 child 按定义筛选工具，不继承 manager 本身。
    mcpManager?: McpManagerLike;

    // 当前 Session 的任务视图；任务状态归 Root Runtime 管理，子 Agent 默认不继承。
    tasks?: TaskSessionLike;

    // 当前 Session 的 Hook 生命周期状态，用于 once 原子 claim。
    // 状态归 Session Runtime，不得放入 Root Hook Runtime。
    hookSession?: HookSessionRuntime;
    turnId: string;
    holdHookConfiguration?: () => () => void;
    onHookEvent?: (event: HookLifecycleEvent) => void | Promise<void>;
    runHook?: (input: HookInput, signal?: AbortSignal) => Promise<HookBatchResult>;
    hookControl?: {inspect: HookRuntime["inspect"]; reload(signal: AbortSignal): Promise<void>};

    // Root Runtime 统一持有的 Shell 执行边界。前台、后台和子 Agent
    // 通过同一 Runner 获得一致的 Sandbox、取消和输出语义。
    shellRunner: ShellRunnerLike;
}

interface ToolInvocation {
    permissionApproved?: true;
    toolCallId: string;
    userAnswers?: Readonly<Record<string, string>>;
}

// 工具抽象：名字 + 描述 + Zod 参数 schema + 权限声明 + 执行函数
// Zod schema 一处定义，既能自动生成给 LLM 的 JSON Schema，又能运行时校验参数
export interface Tool<T extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    /** 当前 Runtime 中会变化的模型说明，例如热重载后的 Agent Catalog。 */
    getDescription?(): string;
    parameters: T; // Zod schema

    // 控制完整 Schema 是否在首次模型请求中出现。省略时保持 direct。
    // deferred 只影响模型可见性，不改变权限、并发或真实执行能力。
    exposure?: ToolExposure;

    // Tool Search 的补充检索词与来源摘要。外部文本仅用于检索，不能参与权限判断。
    searchHint?: string;
    searchSource?: ToolSearchSource;

    // 外部工具（目前为 MCP）可以直接提供 JSON Schema。
    // 内置工具省略该字段，继续从 Zod schema 生成。
    inputJsonSchema?: Record<string, unknown>;


    // 权限意向声明：返回 allow/deny/ask/passthrough
    // 不写时默认 passthrough，由 executeTool 按 isReadOnly 决定
    checkPermissions?(
        input: z.infer<T>,
        ctx: ToolContext
    ): Promise<PermissionResult>;

    // 给权限规则匹配用的 matcher 工厂
    // 把 input 转成"能跟规则 pattern 匹配的字符串"
    // 默认实现：JSON.stringify(input)
    // bash 覆盖：拆子命令，并按 allow/ask/deny 使用不同匹配策略
    preparePermissionMatcher?(
        input: z.infer<T>
    ): Promise<PermissionMatcher>;

    // 元信息：用于默认权限规则
    // isReadOnly 不写时默认 false（写操作）
    isReadOnly?(input: z.infer<T>): boolean;

    // 同一 assistant message 中可否与相邻安全工具并发执行。
    // 必须显式声明；只读不自动等于并发安全（例如 ask_user / todo_write）。
    isConcurrencySafe?(input: z.infer<T>): boolean;

    // 普通 allow 规则不能静默批准这些操作；交给当前审核者或 Full Access 预授权。
    // ask_user 的答案仍只能由 Host 提供。
    requiresExplicitApproval?(input: z.infer<T>, ctx: ToolContext): boolean;

    // Host 回答经 invocation 传入，不属于模型参数，也不能改写原提问。
    acceptsUserAnswers?: boolean;

    // Default 只自动批准能证明副作用范围的调用。workspace 路径仍会由
    // permission resolver 做 canonical path 校验；sandboxed 只应由确认
    // 当前 OS Sandbox 已 ready 的执行边界声明。省略表示副作用范围未知。
    getDefaultApprovalScope?(
        input: z.infer<T>,
        ctx: ToolContext
    ): DefaultApprovalScope | undefined;

    // 模型可见结果超过该字符数时进入 Tool Result Store。
    // Infinity 表示工具已经自行保证输出有界，禁止递归落盘。
    maxResultSizeChars?: number;

    // 执行：只在权限通过后调用，不再需要自己调 confirm
    execute(
        args: z.infer<T>,
        ctx: ToolContext,
        invocation: ToolInvocation
    ): Promise<ToolOutput>;
}
