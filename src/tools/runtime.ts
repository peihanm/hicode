import type {HookRuntime} from "../hooks/index.js";
import type {OpenAITool} from "../llm/types.js";
import type {ToolExecutionResult} from "../toolResults/index.js";
import {createToolCatalog} from "./catalog.js";
import {createToolDiscovery, type ToolDiscoverySnapshot,} from "./discovery.js";
import {executeRegisteredTool, inlineToolResult, isToolConcurrencySafe,} from "./execute.js";
import {TOOL_SEARCH_NAME} from "./toolSearch/toolSearch.js";
import type {Tool, ToolContext} from "./types.js";

export interface ToolRuntime {
    readonly toolNames: readonly string[];

    getToolSchemas(): OpenAITool[];

    isConcurrencySafe(name: string, argsJson: string): boolean;

    executeTool(
        name: string,
        argsJson: string,
        ctx: ToolContext,
        toolCallId: string
    ): Promise<ToolExecutionResult>;

    getToolDiscoverySnapshot(): ToolDiscoverySnapshot;

    restoreToolDiscovery(snapshot?: ToolDiscoverySnapshot): void;
}

export interface CreateToolRuntimeOptions {
    allowedToolNames?: readonly string[];
    additionalTools?: readonly Tool[];
    /**
     * 用于受限 Runtime 对内置工具收窄权限或能力。只能覆盖已经存在的工具名，
     * 避免子 Runtime 通过同名 additional tool 意外扩大能力。
     */
    toolOverrides?: readonly Tool[];
    /** Root Runtime 的可信 Command Hook；受限子 Runtime 不传入。 */
    hooks?: HookRuntime;
}

export function createToolRuntime(
    options: CreateToolRuntimeOptions = {}
): ToolRuntime {
    const catalog = createToolCatalog(options);
    const discovery = createToolDiscovery(catalog.registrations);
    const runtimeTools = discovery.searchTool
        ? [...catalog.tools, discovery.searchTool]
        : catalog.tools;
    const runtimeMap = new Map(runtimeTools.map((tool) => [tool.name, tool]));

    return {
        toolNames: catalog.tools.map((tool) => tool.name),
        getToolSchemas() {
            return discovery.getVisibleSchemas();
        },
        isConcurrencySafe(name, argsJson) {
            // Hooks can change arguments or produce their own side effects. Keep the
            // whole invocation serial without running hooks twice during preparation.
            if (options.hooks?.enabled) return false;
            if (!discovery.isExposed(name)) return false;
            return isToolConcurrencySafe(runtimeMap, name, argsJson);
        },
        async executeTool(name, argsJson, ctx, toolCallId) {
            if (discovery.isDeferred(name) && !discovery.isExposed(name)) {
                return inlineToolResult(
                    `工具 ${name} 尚未加载。请先调用 ${TOOL_SEARCH_NAME}（可使用 query="select:${name}"），并在下一次模型请求中调用该工具。`,
                    "failed"
                );
            }
            if (discovery.isDeferred(name)) {
                discovery.touch(name);
            }
            try {
                const result = await executeRegisteredTool(
                    runtimeMap,
                    name,
                    argsJson,
                    ctx,
                    toolCallId,
                    options.hooks
                );
                if (name === TOOL_SEARCH_NAME) {
                    discovery.settleSearch(toolCallId, result.outcome === "ok");
                }
                return result;
            } catch (error) {
                if (name === TOOL_SEARCH_NAME) {
                    discovery.settleSearch(toolCallId, false);
                }
                throw error;
            }
        },
        getToolDiscoverySnapshot() {
            return discovery.getSnapshot();
        },
        restoreToolDiscovery(snapshot) {
            discovery.restore(snapshot);
        },
    };
}

export type {ToolDiscoverySnapshot} from "./discovery.js";
export {MAX_LOADED_DEFERRED_TOOLS} from "./discovery.js";
