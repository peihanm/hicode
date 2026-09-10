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
    /** Root-owned live capabilities; sampled before discovery and execution. */
    getAdditionalTools?: () => readonly Tool[];
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
    let additional = options.getAdditionalTools?.() ?? options.additionalTools ?? [];
    let catalog = createToolCatalog({...options, additionalTools: additional});
    let discovery = createToolDiscovery(catalog.registrations);
    let runtimeMap = new Map([...catalog.tools, ...(discovery.searchTool ? [discovery.searchTool] : [])]
        .map(tool => [tool.name, tool]));
    const synchronize = () => {
        if (!options.getAdditionalTools) return;
        const next = options.getAdditionalTools();
        if (next.length === additional.length && next.every((tool, i) => tool === additional[i])) return;
        const nextCatalog = createToolCatalog({...options, additionalTools: next});
        const nextDiscovery = createToolDiscovery(nextCatalog.registrations);
        // Changed same-name tools must be discovered again; an old schema is not authorization.
        const unchanged = new Set(next.filter(tool => additional.includes(tool)).map(tool => tool.name));
        nextDiscovery.restore({version: 2, loadedNames: discovery.getSnapshot().loadedNames.filter(name => unchanged.has(name))});
        catalog = nextCatalog;
        discovery = nextDiscovery;
        runtimeMap = new Map([...catalog.tools, ...(discovery.searchTool ? [discovery.searchTool] : [])]
            .map(tool => [tool.name, tool]));
        additional = next;
    };

    return {
        get toolNames() { synchronize(); return catalog.tools.map(tool => tool.name); },
        getToolSchemas() {
            synchronize();
            return discovery.getVisibleSchemas();
        },
        isConcurrencySafe(name, argsJson) {
            synchronize();
            // Candidate hooks may rewrite input or change files. Match names only:
            // evaluating conditions here would race rewrites and consume once twice.
            if (options.hooks?.hasToolHooks(name)) return false;
            if (!discovery.isExposed(name)) return false;
            return isToolConcurrencySafe(runtimeMap, name, argsJson);
        },
        async executeTool(name, argsJson, ctx, toolCallId) {
            synchronize();
            const executionDiscovery = discovery;
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
                    executionDiscovery.settleSearch(toolCallId, result.outcome === "ok");
                }
                return result;
            } catch (error) {
                if (name === TOOL_SEARCH_NAME) {
                    executionDiscovery.settleSearch(toolCallId, false);
                }
                throw error;
            }
        },
        getToolDiscoverySnapshot() {
            synchronize();
            return discovery.getSnapshot();
        },
        restoreToolDiscovery(snapshot) {
            synchronize();
            discovery.restore(snapshot);
        },
    };
}

export type {ToolDiscoverySnapshot} from "./discovery.js";
export {MAX_LOADED_DEFERRED_TOOLS} from "./discovery.js";
