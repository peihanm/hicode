import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdir, open, realpath} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import type {LoadedMcpServerConfig, McpApprovalDecision} from "./types.js";
import {stableJson} from "./json.js";

const MAX_APPROVAL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_APPROVAL_RECORDS = 10_000;
const MAX_TEXT_CHARS = 16_384;

interface ApprovalRecord {
    projectPath: string;
    serverName: string;
    configHash: string;
    decision: "allow" | "deny";
    decidedAt: string;
}

interface ApprovalDocument {
    version: 1;
    approvals: ApprovalRecord[];
}

function isMissing(error: unknown): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error &&
        (error as {code?: string}).code === "ENOENT"
    );
}

function parseApprovalDocument(value: unknown): ApprovalDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid MCP approval document format");
    }
    const document = value as Partial<ApprovalDocument>;
    if (
        Object.keys(document).some((key) =>
            key !== "version" && key !== "approvals"
        ) ||
        document.version !== 1 ||
        !Array.isArray(document.approvals) ||
        document.approvals.length > MAX_APPROVAL_RECORDS
    ) {
        throw new Error("Invalid MCP approval document format");
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
                "decision",
                "decidedAt",
            ].includes(key)) ||
            typeof item.projectPath !== "string" ||
            item.projectPath.length === 0 ||
            item.projectPath.length > MAX_TEXT_CHARS ||
            typeof item.serverName !== "string" ||
            item.serverName.length === 0 ||
            item.serverName.length > 64 ||
            typeof item.configHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(item.configHash) ||
            (item.decision !== "allow" && item.decision !== "deny") ||
            typeof item.decidedAt !== "string" ||
            !Number.isFinite(Date.parse(item.decidedAt)) ||
            seen.has(identity)
        ) {
            throw new Error("MCP approval document contains invalid or duplicate records");
        }
        seen.add(identity);
        approvals.push(item as ApprovalRecord);
    }
    return {version: 1, approvals};
}

async function readDocument(path: string): Promise<ApprovalDocument> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
            throw new Error("MCP approval document is not a safe regular file");
        }
        if (metadata.size > MAX_APPROVAL_FILE_BYTES) {
            throw new Error("MCP approval document exceeds the size limit");
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
        if (offset > MAX_APPROVAL_FILE_BYTES) {
            throw new Error("MCP approval document exceeds the size limit");
        }
        const text = new TextDecoder("utf-8", {fatal: true}).decode(
            buffer.subarray(0, offset)
        );
        return parseApprovalDocument(JSON.parse(text));
    } catch (error) {
        if (isMissing(error)) return {version: 1, approvals: []};
        throw error;
    } finally {
        await handle?.close();
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
    const env = Object.fromEntries(
        Object.entries(server.config.env ?? {}).map(([key, value]) => [
            key,
            createHash("sha256").update(value).digest("hex"),
        ])
    );
    const canonical = stableJson({
        projectPath,
        serverName: server.name,
        type: server.config.type,
        command: server.config.command,
        args: server.config.args,
        env,
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
): Promise<"allow" | "deny" | "pending"> {
    const match = (await readDocument(path)).approvals.find(
        (item) => item.projectPath === identity.projectPath &&
            item.serverName === serverName &&
            item.configHash === identity.configHash
    );
    return match?.decision ?? "pending";
}

export async function saveMcpApproval(
    path: string,
    identity: {projectPath: string; configHash: string},
    serverName: string,
    decision: Extract<McpApprovalDecision, "always" | "deny">
): Promise<void> {
    await ensureSafeParent(path);
    await withFileLock(`${path}.lock`, async () => {
        const document = await readDocument(path);
        const approvals = document.approvals.filter(
            (item) => !(item.projectPath === identity.projectPath &&
                item.serverName === serverName)
        );
        approvals.push({
            projectPath: identity.projectPath,
            serverName,
            configHash: identity.configHash,
            decision: decision === "always" ? "allow" : "deny",
            decidedAt: new Date().toISOString(),
        });
        const updated = parseApprovalDocument({version: 1, approvals});
        const content = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_APPROVAL_FILE_BYTES) {
            throw new Error("MCP approval document exceeds the size limit");
        }
        await writeFileAtomically(path, content, 0o600);
    });
}
