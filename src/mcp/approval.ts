import {z} from "zod";
import {createHash} from "node:crypto";
import {lstat, mkdir, realpath} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import {hasFileSystemErrorCode} from "../persistence/errors.js";
import {readBoundedTextFile} from "../persistence/readTextFile.js";
import type {LoadedMcpServerConfig, McpToolPolicy} from "./types.js";
import {stableJson} from "./json.js";

const MAX_APPROVAL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_APPROVAL_RECORDS = 10_000;
const MAX_TEXT_CHARS = 16_384;

export const mcpToolPolicySchema = z.object({
    exceptions: z.record(z.string().regex(/^mcp__[A-Za-z0-9_]{1,59}$/), z.enum(["ask", "deny"]))
        .refine(value => Object.keys(value).length <= 100, "Too many MCP tool exceptions"),
}).strict();

interface ApprovalRecord {
    toolPolicy?: McpToolPolicy;
    projectPath: string;
    serverName: string;
    configHash: string;
    decidedAt: string;
}

interface ApprovalDocument {
    version: 2;
    approvals: ApprovalRecord[];
}

function parseApprovalDocument(value: unknown): ApprovalDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid MCP approval document format (expected version 2)");
    }
    const document = value as Partial<ApprovalDocument>;
    if (
        Object.keys(document).some((key) =>
            key !== "version" && key !== "approvals"
        ) ||
        document.version !== 2 ||
        !Array.isArray(document.approvals) ||
        document.approvals.length > MAX_APPROVAL_RECORDS
    ) {
        throw new Error("Invalid MCP approval document format (expected version 2)");
    }
    const approvals: ApprovalRecord[] = [];
    const seen = new Set<string>();
    for (const raw of document.approvals) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("MCP approval document contains invalid records");
        }
        const item = raw as Partial<ApprovalRecord>;
        const keys = Object.keys(item);
        const identity = `${item.projectPath}\0${item.serverName}`;
        if (
            keys.some((key) => ![
                "projectPath",
                "serverName",
                "configHash",
                "decidedAt",
                "toolPolicy",
            ].includes(key)) ||
            typeof item.projectPath !== "string" ||
            item.projectPath.length === 0 ||
            item.projectPath.length > MAX_TEXT_CHARS ||
            typeof item.serverName !== "string" ||
            item.serverName.length === 0 ||
            item.serverName.length > 64 ||
            typeof item.configHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(item.configHash) ||
            typeof item.decidedAt !== "string" ||
            !Number.isFinite(Date.parse(item.decidedAt)) ||
            seen.has(identity) ||
            (item.toolPolicy !== undefined && !mcpToolPolicySchema.safeParse(item.toolPolicy).success)
        ) {
            throw new Error("MCP approval document contains invalid or duplicate records");
        }
        seen.add(identity);
        approvals.push(item as ApprovalRecord);
    }
    return {version: 2, approvals};
}

function readDocument(path: string): ApprovalDocument {
    try {
        const text = readBoundedTextFile(path, MAX_APPROVAL_FILE_BYTES);
        return parseApprovalDocument(JSON.parse(text));
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return {version: 2, approvals: []};
        throw error;
    }
}

async function ensureSafeParent(path: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("MCP approval directory is not a safe directory");
    }
}

async function canonicalProjectPath(cwd: string): Promise<string> {
    try {
        return await realpath(cwd);
    } catch {
        return resolve(cwd);
    }
}

export async function createMcpApprovalIdentity(
    cwd: string,
    server: LoadedMcpServerConfig
): Promise<{projectPath: string; configHash: string}> {
    const projectPath = await canonicalProjectPath(cwd);
    const config = server.config;
    const env = config.type === "stdio" ? Object.fromEntries(
        Object.entries(config.env ?? {}).map(([key, value]) => [
            key,
            createHash("sha256").update(value).digest("hex"),
        ])
    ) : undefined;
    const canonical = stableJson({
        projectPath,
        serverName: server.name,
        type: server.config.type,
        ...(config.type === "stdio" ? {command: config.command, args: config.args, env} : {url: config.url}),
        timeoutMs: server.config.timeoutMs,
        toolTimeoutMs: server.config.toolTimeoutMs,
    });
    return {
        projectPath,
        configHash: createHash("sha256").update(canonical).digest("hex"),
    };
}

export async function getMcpApproval(
    path: string,
    identity: {projectPath: string; configHash: string},
    serverName: string
): Promise<{decision: "allow" | "pending"; toolPolicy?: McpToolPolicy}> {
    const match = readDocument(path).approvals.find(
        (item) => item.projectPath === identity.projectPath &&
            item.serverName === serverName &&
            item.configHash === identity.configHash
    );
    return {decision: match ? "allow" : "pending", ...(match?.toolPolicy ? {toolPolicy: match.toolPolicy} : {})};
}

export async function saveMcpApproval(
    path: string,
    identity: {projectPath: string; configHash: string},
    serverName: string,
    toolPolicy?: McpToolPolicy
): Promise<void> {
    await ensureSafeParent(path);
    await withFileLock(`${path}.lock`, async () => {
        const document = readDocument(path);
        const approvals = document.approvals.filter(
            (item) => !(item.projectPath === identity.projectPath &&
                item.serverName === serverName)
        );
        approvals.push({
            projectPath: identity.projectPath,
            serverName,
            configHash: identity.configHash,
            decidedAt: new Date().toISOString(),
            ...(toolPolicy ? {toolPolicy: mcpToolPolicySchema.parse(toolPolicy)} : {}),
        });
        const updated = parseApprovalDocument({version: 2, approvals});
        const content = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_APPROVAL_FILE_BYTES) {
            throw new Error("MCP approval document exceeds the size limit");
        }
        await writeFileAtomically(path, content, 0o600);
    });
}
