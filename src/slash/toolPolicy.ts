import type {ToolSchemaProvider} from "../agent/invokePreparation.js";
import type {ToolExecutor} from "../agent/toolBatch.js";

export interface CommandAgentTools {
    getToolSchemas: ToolSchemaProvider;
    executeTool: ToolExecutor;
    isToolConcurrencySafe(name: string, argsJson: string): boolean;
}

export function applyCommandToolPolicy(
    tools: CommandAgentTools,
    allowedToolNames: readonly string[] | undefined
): CommandAgentTools {
    if (allowedToolNames === undefined) return tools;
    const allowed = new Set(allowedToolNames);
    if (allowed.size !== allowedToolNames.length) {
        throw new Error("Prompt Slash Tool Policy 包含重复工具名");
    }
    const schemas = tools.getToolSchemas();
    const available = new Set(schemas.map((schema) => schema.function.name));
    const unknown = [...allowed].filter((name) => !available.has(name));
    if (unknown.length > 0) {
        throw new Error(
            `Prompt Slash Tool Policy 包含当前 Runtime 不可用的工具: ${unknown.join(", ")}`
        );
    }
    const scopedSchemas = schemas.filter((schema) =>
        allowed.has(schema.function.name)
    );
    return {
        getToolSchemas: () => scopedSchemas,
        async executeTool(name, argsJson, ctx, toolCallId) {
            if (!allowed.has(name)) {
                const content = `当前 Prompt Slash 的只读/事务边界不允许调用工具: ${name}`;
                return {
                    modelContent: content,
                    displayContent: content,
                    outcome: "denied",
                };
            }
            return tools.executeTool(name, argsJson, ctx, toolCallId);
        },
        isToolConcurrencySafe(name, argsJson) {
            return allowed.has(name) &&
                tools.isToolConcurrencySafe(name, argsJson);
        },
    };
}
