import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import type {OpenAITool} from "../llm/types.js";

export const MCP_CALL_NAME = "mcp_call";

export const mcpCallParameters = z.object({
    tool: z.string().min(1).max(256).describe("Exact MCP tool name returned by tool_search."),
    arguments: z.record(z.unknown()).describe("Arguments matching the target tool input schema."),
}).strict();

export const mcpCallSchema: OpenAITool = {
    type: "function",
    function: {
        name: MCP_CALL_NAME,
        description: "Call an available MCP tool by its exact name and arguments. Use tool_search to look up its description and full input schema when needed. The target's current permissions and input validation still apply. This gateway cannot call native tools.",
        parameters: zodToJsonSchema(mcpCallParameters, {target: "jsonSchema7"}) as Record<string, unknown>,
    },
};

/** Requested identity for events and batch accounting; this never authorizes execution. */
export function toolCallTarget(name: string, argsJson: string): {name: string; argsJson: string} {
    if (name === MCP_CALL_NAME) {
        try {
            const parsed = mcpCallParameters.safeParse(JSON.parse(argsJson));
            if (parsed.success && parsed.data.tool.startsWith("mcp__")) return {name: parsed.data.tool, argsJson: JSON.stringify(parsed.data.arguments)};
        } catch { /* Invalid envelopes retain their gateway identity in diagnostics. */ }
    }
    return {name, argsJson};
}
