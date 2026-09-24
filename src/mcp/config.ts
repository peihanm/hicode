import {readBoundedTextFile} from "../persistence/readTextFile.js";
import {lstat, realpath} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {z} from "zod";
import type {HiCodeStorageLayout} from "../persistence/index.js";
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

const serverOptions = {
    disabled: z.boolean().optional().default(false),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional()
        .default(DEFAULT_CONNECTION_TIMEOUT_MS),
    toolTimeoutMs: z.number().int().min(1_000).max(30 * 60_000).optional()
        .default(DEFAULT_TOOL_TIMEOUT_MS),
};

const stdioShape = {
    ...serverOptions,
    type: z.literal("stdio").optional().default("stdio"),
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string().max(16_384)).max(MAX_ARGS).optional().default([]),
    env: z.record(
        z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(64 * 1024)
    ).refine(value => Object.keys(value).length <= MAX_ENV_ENTRIES, "Too many Server env entries").optional(),
};
const httpShape = {
    ...serverOptions,
    type: z.literal("http").optional().default("http"),
    url: z.string().min(1).max(4096).refine(value => {
        try {
            const url = new URL(value);
            return !/[\s\x00-\x1f\x7f]/.test(value) && ["http:", "https:"].includes(url.protocol) &&
                !url.username && !url.password && !url.hash;
        } catch {return false;}
    }, "MCP URL must be HTTP(S), without credentials, whitespace or a fragment")
        .transform(value => new URL(value).href),
};
const serverSchema = z.union([z.object(stdioShape).strict(), z.object(httpShape).strict()]);

const name = z.string().trim().refine(validateMcpServerName, {
    message: "Use only letters, digits, _, - and ., with length 1–64",
});
export const hostMcpServerContributionSchema = z.union([
    z.object({name, ...stdioShape}).strict(),
    z.object({name, ...httpShape}).strict(),
]);

function isMissing(error: unknown): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error &&
        ((error as {code?: string}).code === "ENOENT" ||
            (error as {code?: string}).code === "ENOTDIR")
    );
}

function readBoundedRegularFile(path: string): string | undefined {
    try {return readBoundedTextFile(path, MAX_CONFIG_BYTES);}
    catch (error) {if (isMissing(error)) return undefined; throw error;}
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
            directoryPath !== join(cwdPath, ".hicode")
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
    storage: HiCodeStorageLayout,
    cwd: string,
    sources: readonly McpConfigSource[] = ["user", "project"],
    hostServers: readonly HostMcpServerContribution[] = []
): Promise<LoadedMcpConfig> {
    const userPath = join(storage.hicodeHome, "mcp.json");
    const compatProjectPath = resolve(cwd, ".mcp.json");
    const projectPath = resolve(cwd, ".hicode", "mcp.json");
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
