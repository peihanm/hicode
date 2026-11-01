import type {ToolHookRuntime} from "../hooks/index.js";
import type {OpenAITool} from "../llm/types.js";
import type {ToolExecutionResult} from "../toolResults/index.js";
import {createToolCatalog, schemaForTool} from "./catalog.js";
import {executeRegisteredTool, formatInterruptedToolResult, inlineToolResult, isToolConcurrencySafe} from "./execute.js";
import {MCP_CALL_NAME, mcpCallParameters, mcpCallSchema} from "./mcpCall.js";
import {createToolSearchTool} from "./toolSearch/toolSearch.js";
import {buildToolSearchDocument, createToolSearchIndex} from "./toolSearch/searchIndex.js";
import type {Tool, ToolContext} from "./types.js";

export interface ToolRuntime {
    readonly toolNames: readonly string[];
    getTools(): readonly Tool[];
    getToolSchemas(): OpenAITool[];
    isConcurrencySafe(name: string, argsJson: string): boolean;
    executeTool(name: string, argsJson: string, ctx: ToolContext, toolCallId: string): Promise<ToolExecutionResult>;
}

interface CreateToolRuntimeOptions {
    skillsAvailable?: boolean;
    allowedToolNames?: readonly string[];
    additionalTools?: readonly Tool[];
    /** Root-owned live capabilities, sampled before schema projection and execution. */
    getAdditionalTools?: () => readonly Tool[];
    /** Restricted runtimes may narrow existing builtins only. */
    toolOverrides?: readonly Tool[];
    hooks?: ToolHookRuntime;
}

export function createToolRuntime(options: CreateToolRuntimeOptions = {}): ToolRuntime {
    let additional = options.getAdditionalTools?.() ?? options.additionalTools ?? [];
    const build = (tools: readonly Tool[], allowedToolNames = options.allowedToolNames) => {
        const catalog = createToolCatalog({...options, allowedToolNames, additionalTools: tools});
        const mcp = catalog.registrations.filter(registration => registration.tool.mcp);
        const search = mcp.length ? createToolSearchTool(createToolSearchIndex(mcp.map(registration =>
            buildToolSearchDocument(registration.tool, registration.schema())))) : undefined;
        return {catalog, search, map: new Map([...catalog.tools, ...(search ? [search] : [])].map(tool => [tool.name, tool]))};
    };
    let current = build(additional);
    const synchronize = () => {
        if (!options.getAdditionalTools) return;
        const next = options.getAdditionalTools();
        if (next.length === additional.length && next.every((tool, index) => tool === additional[index])) return;
        // Configured scopes are validated at construction. Removal revokes a capability;
        // it must not make the remaining local/other-server tools unusable.
        const present = new Set([...next, ...current.catalog.tools.filter(tool => !additional.some(extra => extra.name === tool.name))].map(tool => tool.name));
        current = build(next, options.allowedToolNames?.filter(name => present.has(name)));
        additional = next;
    };
    const resolve = (name: string, argsJson: string): {name: string; argsJson: string} | {error: string} => {
        if (name !== MCP_CALL_NAME) {
            if (current.map.get(name)?.mcp) return {error: `Call MCP tools through ${MCP_CALL_NAME}, not by their tool name directly.`};
            return {name, argsJson};
        }
        let input;
        try { input = mcpCallParameters.safeParse(JSON.parse(argsJson)); }
        catch { return {error: "Invalid mcp_call arguments: expected a JSON object with tool and arguments."}; }
        if (!input.success) return {error: `Invalid mcp_call arguments: ${input.error.message}`};
        const target = current.map.get(input.data.tool);
        if (!target?.mcp) return {error: `MCP tool ${input.data.tool} is unavailable in this scope. Use tool_search to inspect current tools.`};
        try { return {name: target.name, argsJson: JSON.stringify(input.data.arguments)}; }
        catch { return {error: "Invalid mcp_call arguments: input nesting exceeds the JSON serialization limit."}; }
    };
    return {
        get toolNames() { synchronize(); return current.catalog.tools.map(tool => tool.name); },
        getTools() { synchronize(); return [...current.catalog.tools]; },
        getToolSchemas() {
            synchronize();
            return [
                ...current.catalog.registrations.filter(registration => !registration.tool.mcp).map(registration => registration.schema()),
                ...(current.search ? [schemaForTool(current.search), mcpCallSchema] : []),
            ];
        },
        isConcurrencySafe(name, argsJson) {
            synchronize();
            const target = resolve(name, argsJson);
            if ("error" in target || options.hooks?.hasToolHooks(target.name)) return false;
            return isToolConcurrencySafe(current.map, target.name, target.argsJson);
        },
        async executeTool(name, argsJson, ctx, toolCallId) {
            if (ctx.signal.aborted) return inlineToolResult(formatInterruptedToolResult(ctx.signal), "interrupted");
            synchronize();
            const target = resolve(name, argsJson);
            if ("error" in target) return inlineToolResult(target.error, "failed");
            return executeRegisteredTool(current.map, target.name, target.argsJson, ctx, toolCallId, options.hooks);
        },
    };
}
