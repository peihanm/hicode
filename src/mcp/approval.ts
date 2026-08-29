import {createHash} from "node:crypto";
import {mkdir, readFile, realpath, rename, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import type {LoadedMcpServerConfig, McpApprovalDecision} from "./types.js";
import {stableJson} from "./json.js";

interface ApprovalRecord {
    projectPath: string;
    serverName: string;
    configHash: string;
    decision: "allow" | "deny";
    decidedAt: string;
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
): Promise<{ projectPath: string; configHash: string }> {
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

async function readRecords(path: string): Promise<ApprovalRecord[]> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
    } catch {
        return [];
    }
}

export function defaultMcpApprovalPath(): string {
    return join(homedir(), ".pillar", "mcp-approvals.json");
}

export async function getMcpApproval(
    path: string,
    identity: { projectPath: string; configHash: string },
    serverName: string
): Promise<"allow" | "deny" | "pending"> {
    const match = (await readRecords(path)).find(
        (item) => item.projectPath === identity.projectPath &&
            item.serverName === serverName && item.configHash === identity.configHash
    );
    return match?.decision ?? "pending";
}

export async function saveMcpApproval(
    path: string,
    identity: { projectPath: string; configHash: string },
    serverName: string,
    decision: Exclude<McpApprovalDecision, "once">
): Promise<void> {
    const records = (await readRecords(path)).filter(
        (item) => !(item.projectPath === identity.projectPath && item.serverName === serverName)
    );
    records.push({
        projectPath: identity.projectPath,
        serverName,
        configHash: identity.configHash,
        decision: decision === "always" ? "allow" : "deny",
        decidedAt: new Date().toISOString(),
    });
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, {mode: 0o600});
    await rename(temporary, path);
}
