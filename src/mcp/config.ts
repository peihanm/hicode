import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {z} from "zod";
import type {PillarStorageLayout} from "../persistence/index.js";
import {normalizeMcpName, validateMcpServerName} from "./names.js";
import type {
    LoadedMcpConfig,
    LoadedMcpServerConfig,
    McpConfigIssue,
    McpConfigSource,
    HostMcpServerContribution,
} from "./types.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SERVERS_PER_SOURCE = 64;
const MAX_ARGS = 128;
const MAX_ENV_ENTRIES = 128;

const serverShape = {
    type: z.literal("stdio").optional().default("stdio"),
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string().max(16_384)).max(MAX_ARGS).optional().default([]),
    env: z.record(
        z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(64 * 1024)
    ).optional(),
    disabled: z.boolean().optional().default(false),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional()
        .default(DEFAULT_CONNECTION_TIMEOUT_MS),
    toolTimeoutMs: z.number().int().min(1_000).max(30 * 60_000).optional()
        .default(DEFAULT_TOOL_TIMEOUT_MS),
};

const serverSchema = z.object(serverShape).strict();

export const hostMcpServerContributionSchema = z
    .object({
        name: z.string().trim().refine(validateMcpServerName, {
            message: "Use only letters, digits, _, - and ., with length 1–64",
        }),
        ...serverShape,
    })
    .strict();

function isMissing(error: unknown): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error &&
        ((error as {code?: string}).code === "ENOENT" ||
            (error as {code?: string}).code === "ENOTDIR")
    );
}

async function readBoundedRegularFile(path: string): Promise<string | undefined> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new Error("Configuration must be a regular file");
        if (metadata.size > MAX_CONFIG_BYTES) {
            throw new Error(`Configuration exceeds ${MAX_CONFIG_BYTES} byte limit`);
        }
        const buffer = Buffer.alloc(metadata.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const {bytesRead} = await handle.read(
                buffer,
                offset,
                buffer.length - offset,
                offset
            );
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > MAX_CONFIG_BYTES) {
            throw new Error(`Configuration exceeds ${MAX_CONFIG_BYTES} byte limit`);
        }
        return new TextDecoder("utf-8", {fatal: true}).decode(
            buffer.subarray(0, offset)
        );
    } finally {
        await handle.close();
    }
}

async function validateNativeProjectDirectory(
    cwd: string,
    path: string
): Promise<void> {
    const directory = dirname(path);
    try {
        const [cwdPath, directoryPath, metadata] = await Promise.all([
            realpath(cwd),
            realpath(directory),
            lstat(directory),
        ]);
        if (
            metadata.isSymbolicLink() ||
            !metadata.isDirectory() ||
            directoryPath !== join(cwdPath, ".pillar")
        ) {
            throw new Error("Unsafe project MCP configuration directory");
        }
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
}

async function readConfigSource(
    path: string,
    source: McpConfigSource,
    cwd?: string
): Promise<{servers: LoadedMcpServerConfig[]; issues: McpConfigIssue[]}> {
    try {
        if (cwd) await validateNativeProjectDirectory(cwd, path);
        const text = await readBoundedRegularFile(path);
        if (text === undefined) return {servers: [], issues: []};

        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch (error) {
            return {
                servers: [],
                issues: [{source, path, message: `MCP configuration is not valid JSON: ${String(error)}`}],
            };
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return {
                servers: [],
                issues: [{source, path, message: "MCP configuration root must be an object"}],
            };
        }
        const top = raw as Record<string, unknown>;
        if (
            !top.mcpServers ||
            typeof top.mcpServers !== "object" ||
            Array.isArray(top.mcpServers)
        ) {
            return {
                servers: [],
                issues: [{source, path, message: "MCP configuration is missing the mcpServers object"}],
            };
        }
        const issues: McpConfigIssue[] = Object.keys(top)
            .filter((key) => key !== "mcpServers")
            .map((key) => ({
                source,
                path,
                message: `MCP configuration contains unknown top-level fields: ${key.slice(0, 128)}`,
            }));
        const entries = Object.entries(
            top.mcpServers as Record<string, unknown>
        ).sort(([left], [right]) => left.localeCompare(right));
        if (entries.length > MAX_SERVERS_PER_SOURCE) {
            issues.push({
                source,
                path,
                message: `MCP Servers exceed the per-source limit of ${MAX_SERVERS_PER_SOURCE} items`,
            });
        }
        const servers: LoadedMcpServerConfig[] = [];
        for (const [name, value] of entries.slice(0, MAX_SERVERS_PER_SOURCE)) {
            if (!validateMcpServerName(name)) {
                issues.push({
                    source,
                    path,
                    serverName: name.slice(0, 128),
                    message: "Server name must contain only letters, digits, _, - and ., with length 1–64",
                });
                continue;
            }
            const parsed = serverSchema.safeParse(value);
            if (!parsed.success) {
                issues.push({
                    source,
                    path,
                    serverName: name,
                    message: `Invalid Server configuration: ${parsed.error.issues
                        .map((item) => item.message)
                        .join("; ")}`.slice(0, 2000),
                });
                continue;
            }
            if (Object.keys(parsed.data.env ?? {}).length > MAX_ENV_ENTRIES) {
                issues.push({
                    source,
                    path,
                    serverName: name,
                    message: `Server env exceeds ${MAX_ENV_ENTRIES} entries`,
                });
                continue;
            }
            servers.push({name, source, path, config: parsed.data});
        }
        return {servers, issues};
    } catch (error) {
        return {
            servers: [],
            issues: [{
                source,
                path,
                message: `Cannot safely read MCP configuration: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
            }],
        };
    }
}

export async function loadMcpConfig(
    storage: PillarStorageLayout,
    cwd: string,
    sources: readonly McpConfigSource[] = ["user", "project"],
    hostServers: readonly HostMcpServerContribution[] = []
): Promise<LoadedMcpConfig> {
    const userPath = join(storage.pillarHome, "mcp.json");
    const compatProjectPath = resolve(cwd, ".mcp.json");
    const projectPath = resolve(cwd, ".pillar", "mcp.json");
    const [user, compatProject, project] = await Promise.all([
        sources.includes("user")
            ? readConfigSource(userPath, "user")
            : {servers: [], issues: []},
        sources.includes("project")
            ? readConfigSource(compatProjectPath, "project")
            : {servers: [], issues: []},
        sources.includes("project")
            ? readConfigSource(projectPath, "project", cwd)
            : {servers: [], issues: []},
    ]);
    const byName = new Map<string, LoadedMcpServerConfig>();
    for (const server of [
        ...user.servers,
        ...compatProject.servers,
        ...project.servers,
        ...hostServers.map((server) => {
            const parsed = hostMcpServerContributionSchema.parse(server);
            const {name, ...config} = parsed;
            return {
                name,
                source: "host" as const,
                id: name,
                config,
            };
        }),
    ]) byName.set(server.name, server);

    const issues = [...user.issues, ...compatProject.issues, ...project.issues];
    const normalized = new Map<string, string>();
    const servers: LoadedMcpServerConfig[] = [];
    for (const server of byName.values()) {
        const key = normalizeMcpName(server.name);
        const existing = normalized.get(key);
        if (existing && existing !== server.name) {
            issues.push({
                ...(server.source === "host"
                    ? {source: "host" as const, id: server.id}
                    : {source: server.source, path: server.path}),
                serverName: server.name,
                message: `Normalized Server name conflicts with ${existing} .`,
            });
            continue;
        }
        normalized.set(key, server.name);
        servers.push(server);
    }
    return {servers, issues};
}
