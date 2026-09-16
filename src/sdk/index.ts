export {HiCode} from "./hicode.js";
export {loadHiCodeHostConfig} from "./hostConfig.js";
export {collectTurnResult} from "./resultCollector.js";
export {defineHiCodeTool} from "./hostTools.js";
export {HiCodeSDKError} from "./types.js";

export type {
    LoadedHiCodeHostConfig,
    LoadHiCodeHostConfigOptions,
    HiCodeHostSettingsIssue,
    HiCodeHostSettingsOrigins,
} from "./hostConfig.js";

export type {
    HostDiagnostic,
    InteractionContext,
    HiCodeHost,
    HiCodeHostTool,
    HiCodeHostToolContext,
    HiCodeHostToolOutput,
    HiCodeOptions,
    StartThreadOptions,
    StreamedTurn,
    Thread,
    ThreadInfo,
    TurnOptions,
    TurnResult,
} from "./types.js";

export type {
    AgentMessageItem,
    CompactItem,
    DiagnosticItem,
    EventEnvelope,
    FileChangeItem,
    InteractionItem,
    InteractionRequest,
    InteractionResponse,
    MemoryChangeItem,
    SDKErrorInfo,
    SubagentItem,
    ThreadEvent,
    TurnProgressPhase,
    ThreadItem,
    ThreadItemStatus,
    TodoListItem,
    ToolCallItem,
    Usage,
} from "./protocol.js";

export type {HiCodeStorageLayout} from "../persistence/index.js";
export type {
    HiCodeSettingsFile,
    ResolvedHiCodeSettings,
} from "../settings/index.js";
export type {
    HiCodeFileSources,
    HiCodeRootConfiguration,
    HiCodeRootContributions,
    HostInstructionContribution,
    HostSkillContribution,
    HostAgentContribution,
    HostMcpServerContribution,
} from "../runtime/rootConfiguration.js";

export type {TurnInput} from "../images/input.js";
