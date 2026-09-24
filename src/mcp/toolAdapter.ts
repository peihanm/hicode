import {compileMcpInputSchema} from "./inputSchema.js";
import type {Tool} from "../tools/types.js";
import {buildMcpToolName} from "./names.js";
import {normalizeMcpResultWithArtifacts} from "./result.js";
import type {McpConnectedServer, McpToolPolicy} from "./types.js";

const MAX_DESCRIPTION_CHARS = 2048;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_TOTAL_SCHEMA_CHARS = 512 * 1024;
const MAX_REMOTE_TOOL_NAME_CHARS = 512;

export function adaptMcpTools(server: McpConnectedServer, policy?: McpToolPolicy): {
    tools: Tool[];
    issues: string[];
} {
    const tools: Tool[] = [];
    const issues: string[] = [];
    const names = new Map<string, string>();
    let totalSchemaChars = 0;
    if (server.tools.length > MAX_TOOLS_PER_SERVER) {
        issues.push(`Server returned ${server.tools.length} tools; loading only the first ${MAX_TOOLS_PER_SERVER} items`);
    }
    for (const remote of server.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        if (
            typeof remote.name !== "string" ||
            remote.name.length === 0 ||
            remote.name.length > MAX_REMOTE_TOOL_NAME_CHARS
        ) {
            issues.push("Server returned an invalid or overly long tool name");
            continue;
        }
        const originalName = remote.name;
        const qualifiedName = buildMcpToolName(
            server.config.name,
            originalName
        );
        const existing = names.get(qualifiedName);
        if (existing) {
            issues.push(`Tool ${remote.name} and ${existing} have conflicting normalized names`);
            continue;
        }
        names.set(qualifiedName, remote.name);
        if (!remote.inputSchema || remote.inputSchema.type !== "object") {
            issues.push(`Tool ${remote.name} inputSchema is not an object`);
            continue;
        }
        let schemaChars: number;
        try {schemaChars = JSON.stringify(remote.inputSchema).length;}
        catch {
            issues.push(`Tool ${remote.name} inputSchema is not bounded JSON`);
            continue;
        }
        if (schemaChars > MAX_SCHEMA_CHARS) {
            issues.push(`Tool ${remote.name} inputSchema exceeds ${MAX_SCHEMA_CHARS} characters`);
            continue;
        }
        if (totalSchemaChars + schemaChars > MAX_TOTAL_SCHEMA_CHARS) {
            issues.push(`Combined Server tool schemas exceed ${MAX_TOTAL_SCHEMA_CHARS} characters`);
            break;
        }
        totalSchemaChars += schemaChars;
        let compiled;
        try {
            compiled = compileMcpInputSchema(remote.inputSchema);
        } catch (error) {
            issues.push(`Tool ${remote.name} inputSchema cannot be loaded: ${error instanceof Error ? error.message.slice(0, 500) : "Validation compilation failed"}`);
            continue;
        }
        const description = (remote.description ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_DESCRIPTION_CHARS);
        const annotationReadOnly =
            remote.annotations?.readOnlyHint === true &&
            remote.annotations?.destructiveHint !== true;
        const exception = policy?.exceptions[qualifiedName];
        const tool: Tool = {
            name: qualifiedName,
            description: `[MCP: ${server.config.name}] ${description || originalName}`,
            exposure: "deferred",
            searchHint: `${server.config.name} ${originalName} ${description}`,
            searchSource: {name: server.config.name},
            parameters: compiled.parameters,
            inputJsonSchema: compiled.schema,
            requiresExplicitApproval: () => exception === "ask",
            async checkPermissions() {
                if (exception === "deny") return {behavior: "deny", message: `MCP tool ${qualifiedName} is blocked by the server policy`};
                if (exception === "ask") return {behavior: "ask", allowPersistent: false, message: `MCP tool ${qualifiedName} requires approval by the server policy; change this exception with /mcp`};
                if (exception === "allow" || policy?.default === "allow") return {behavior: "allow"};
                return annotationReadOnly
                    ? {behavior: "passthrough"}
                    : {behavior: "ask", message: `MCP tool ${qualifiedName} requires approval`};
            },
            isReadOnly: () => annotationReadOnly,
            isConcurrencySafe: () => annotationReadOnly,
            async execute(args, ctx, invocation) {
                const result = await server.callTool(originalName, args, ctx.signal);
                return normalizeMcpResultWithArtifacts(result, {
                    store: ctx.toolResultStore,
                    origin: {kind: "tool", toolCallId: invocation.toolCallId, toolName: qualifiedName},
                    imageModelSupported: ctx.imageModelSupported === true,
                    signal: ctx.signal,
                });
            },
        };
        tools.push(tool);
    }
    return {tools, issues};
}
