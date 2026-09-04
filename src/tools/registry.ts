// 工具域公共入口。实现按 Catalog、Discovery、Execute 与 Runtime 分层。
export {formatInterruptedToolResult} from "./execute.js";
export {
    createToolRuntime,
    MAX_LOADED_DEFERRED_TOOLS,
    type ToolRuntime,
    type ToolDiscoverySnapshot,
} from "./runtime.js";
