import {z} from "zod";
import type {Tool} from "../tools/types.js";
import {buildMcpToolName} from "./names.js";
import {normalizeMcpResultWithArtifacts} from "./result.js";
import type {McpConnectedServer} from "./types.js";

const MAX_DESCRIPTION_CHARS = 2048;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_TOTAL_SCHEMA_CHARS = 512 * 1024;
const MAX_REMOTE_TOOL_NAME_CHARS = 512;
const passthroughObject = z.object({}).passthrough();

export function adaptMcpTools(server: McpConnectedServer): {
    tools: Tool[];
    issues: string[];
} {
    const tools: Tool[] = [];
    const issues: string[] = [];
    const names = new Map<string, string>();
    let totalSchemaChars = 0;
    if (server.tools.length > MAX_TOOLS_PER_SERVER) {
        issues.push(`Server 返回 ${server.tools.length} 个工具，只加载前 ${MAX_TOOLS_PER_SERVER} 个`);
    }
    for (const remote of server.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        if (
            typeof remote.name !== "string" ||
            remote.name.length === 0 ||
            remote.name.length > MAX_REMOTE_TOOL_NAME_CHARS
        ) {
            issues.push("Server 返回了无效或过长的工具名");
            continue;
        }
        const originalName = remote.name;
        const qualifiedName = buildMcpToolName(
            server.config.name,
            originalName
        );
        const existing = names.get(qualifiedName);
        if (existing) {
            issues.push(`工具 ${remote.name} 与 ${existing} 规范化后名称冲突`);
            continue;
        }
        names.set(qualifiedName, remote.name);
        if (!remote.inputSchema || remote.inputSchema.type !== "object") {
            issues.push(`工具 ${remote.name} 的 inputSchema 不是 object`);
            continue;
        }
        const schemaChars = JSON.stringify(remote.inputSchema).length;
        if (schemaChars > MAX_SCHEMA_CHARS) {
            issues.push(`工具 ${remote.name} 的 inputSchema 超过 ${MAX_SCHEMA_CHARS} 字符`);
            continue;
        }
        if (totalSchemaChars + schemaChars > MAX_TOTAL_SCHEMA_CHARS) {
            issues.push(`Server 工具 schema 合计超过 ${MAX_TOTAL_SCHEMA_CHARS} 字符`);
            break;
        }
        totalSchemaChars += schemaChars;
        const description = (remote.description ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_DESCRIPTION_CHARS);
        const annotationReadOnly =
            remote.annotations?.readOnlyHint === true &&
            remote.annotations?.destructiveHint !== true;
        const tool: Tool = {
            name: qualifiedName,
            description: `[MCP: ${server.config.name}] ${description || originalName}`,
            exposure: "deferred",
            searchHint: `${server.config.name} ${originalName} ${description}`,
            searchSource: {name: server.config.name},
            parameters: passthroughObject,
            inputJsonSchema: remote.inputSchema as Record<string, unknown>,
            async checkPermissions() {
                return annotationReadOnly
                    ? {behavior: "passthrough"}
                    : {behavior: "ask", message: `MCP 工具 ${qualifiedName} 需要确认`};
            },
            isReadOnly: () => annotationReadOnly,
            isConcurrencySafe: () => annotationReadOnly,
            async execute(args, ctx, invocation) {
                const result = await server.callTool(originalName, args, ctx.signal);
                return normalizeMcpResultWithArtifacts(result, async ({
                                                                          data,
                                                                          mimeType,
                                                                          index,
                                                                      }) => ctx.toolResultStore.persistBinary({
                    toolCallId: invocation.toolCallId,
                    toolName: qualifiedName,
                    data,
                    mimeType,
                    artifactId: `${ctx.toolResultStore.resultIdFor(invocation.toolCallId)}-mcp-${index}`,
                }));
            },
        };
        tools.push(tool);
    }
    return {tools, issues};
}
