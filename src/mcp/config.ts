import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {z} from "zod";
import {normalizeMcpName, validateMcpServerName} from "./names.js";
import type {LoadedMcpConfig, LoadedMcpServerConfig, McpConfigIssue, McpConfigSource,} from "./types.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

const serverSchema = z.object({
    type: z.literal("stdio").optional().default("stdio"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional().default(false),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional()
        .default(DEFAULT_CONNECTION_TIMEOUT_MS),
    toolTimeoutMs: z.number().int().min(1_000).max(30 * 60_000).optional()
        .default(DEFAULT_TOOL_TIMEOUT_MS),
}).strict();

async function readConfigSource(
    path: string,
    source: McpConfigSource
): Promise<{ servers: LoadedMcpServerConfig[]; issues: McpConfigIssue[] }> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {servers: [], issues: []};
        }
        return {
            servers: [],
            issues: [{source, path, message: `无法读取 MCP 配置: ${String(error)}`}],
        };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return {
            servers: [],
            issues: [{source, path, message: `MCP 配置不是合法 JSON: ${String(error)}`}],
        };
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return {
            servers: [],
            issues: [{source, path, message: "MCP 配置顶层必须是对象"}],
        };
    }
    const top = raw as Record<string, unknown>;
    if (!top.mcpServers || typeof top.mcpServers !== "object" || Array.isArray(top.mcpServers)) {
        return {
            servers: [],
            issues: [{source, path, message: "MCP 配置缺少对象字段 mcpServers"}],
        };
    }
    const extraKeys = Object.keys(top).filter((key) => key !== "mcpServers");
    const issues: McpConfigIssue[] = extraKeys.map((key) => ({
        source,
        path,
        message: `MCP 配置包含未知顶层字段: ${key}`,
    }));
    const servers: LoadedMcpServerConfig[] = [];
    for (const [name, value] of Object.entries(top.mcpServers as Record<string, unknown>)) {
        if (!validateMcpServerName(name)) {
            issues.push({source, path, serverName: name, message: "Server 名只能包含字母、数字、_、-、."});
            continue;
        }
        const parsed = serverSchema.safeParse(value);
        if (!parsed.success) {
            issues.push({
                source,
                path,
                serverName: name,
                message: `Server 配置无效: ${parsed.error.issues.map((item) => item.message).join("; ")}`,
            });
            continue;
        }
        servers.push({name, source, path, config: parsed.data});
    }
    return {servers, issues};
}

export async function loadMcpConfig(input: {
    cwd: string;
    userConfigPath?: string;
    compatProjectConfigPath?: string;
    projectConfigPath?: string;
}): Promise<LoadedMcpConfig> {
    const userPath = input.userConfigPath ?? join(homedir(), ".pillar", "mcp.json");
    const compatProjectPath = input.compatProjectConfigPath ?? resolve(input.cwd, ".mcp.json");
    const projectPath = input.projectConfigPath ?? resolve(input.cwd, ".pillar", "mcp.json");
    const [user, compatProject, project] = await Promise.all([
        readConfigSource(userPath, "user"),
        readConfigSource(compatProjectPath, "project"),
        readConfigSource(projectPath, "project"),
    ]);
    const byName = new Map<string, LoadedMcpServerConfig>();
    for (const server of [
        ...user.servers,
        ...compatProject.servers,
        ...project.servers,
    ]) byName.set(server.name, server);

    const issues = [...user.issues, ...compatProject.issues, ...project.issues];
    const normalized = new Map<string, string>();
    const servers: LoadedMcpServerConfig[] = [];
    for (const server of byName.values()) {
        const key = normalizeMcpName(server.name);
        const existing = normalized.get(key);
        if (existing && existing !== server.name) {
            issues.push({
                source: server.source,
                path: server.path,
                serverName: server.name,
                message: `Server 名规范化后与 ${existing} 冲突`,
            });
            continue;
        }
        normalized.set(key, server.name);
        servers.push(server);
    }
    return {servers, issues};
}
