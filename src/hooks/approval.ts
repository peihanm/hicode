import {readBoundedTextFile} from "../persistence/readTextFile.js";
import {chmod, lstat, mkdir} from "node:fs/promises";
import {dirname} from "node:path";
import {hasFileSystemErrorCode, withFileLock, writeFileAtomically} from "../persistence/index.js";

import type {HookTrustDecision} from "./types.js";

const MAX_HOOK_TRUST_FILE_BYTES = 1024 * 1024;
const MAX_HOOK_TRUST_PROJECTS = 10_000;
const MAX_HOOK_PROJECT_PATH_CHARACTERS = 16_384;

interface HookTrustRecord {
    projectPath: string;
    hookId: string;
    decision: "allow" | "deny";
    decidedAt: string;
}

interface HookTrustDocument {
    version: 2;
    projects: HookTrustRecord[];
}

function parseDocument(value: unknown): HookTrustDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid Hook trust document (version 2 definition-level approval required; old project approvals are not reused automatically)");
    }
    const document = value as Partial<HookTrustDocument>;
    if (
        Object.keys(document).some((key) => key !== "version" && key !== "projects") ||
        document.version !== 2 ||
        !Array.isArray(document.projects) ||
        document.projects.length > MAX_HOOK_TRUST_PROJECTS
    ) throw new Error("Invalid Hook trust document (version 2 definition-level approval required; old project approvals are not reused automatically)");
    const projects: HookTrustRecord[] = [];
    const seen = new Set<string>();
    for (const item of document.projects) {
        if (
            !item || typeof item !== "object" || Array.isArray(item) ||
            Object.keys(item).some((key) =>
                key !== "projectPath" && key !== "hookId" && key !== "decision" && key !== "decidedAt"
            ) ||
            typeof item.projectPath !== "string" ||
            item.projectPath.length === 0 ||
            item.projectPath.length > MAX_HOOK_PROJECT_PATH_CHARACTERS ||
            (item.decision !== "allow" && item.decision !== "deny") ||
            typeof item.decidedAt !== "string" ||
            !Number.isFinite(Date.parse(item.decidedAt)) ||
            typeof item.hookId !== "string" || !/^[a-f0-9]{64}$/.test(item.hookId) ||
            seen.has(`${item.projectPath}:${item.hookId}`)
        ) throw new Error("Hook trust document contains invalid or duplicate project records");
        seen.add(`${item.projectPath}:${item.hookId}`);
        projects.push(item);
    }
    return {version: 2, projects};
}

async function readDocument(path: string): Promise<HookTrustDocument> {
    try {
        return parseDocument(JSON.parse(readBoundedTextFile(path, MAX_HOOK_TRUST_FILE_BYTES)));
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) {
            return {version: 2, projects: []};
        }
        throw error;
    }
}

async function ensureSafeParent(path: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Hook trust directory is not a safe directory");
    }
    await chmod(directory, 0o700);
}

/** One validated snapshot for the entire project's definition approval pass. */
export async function readHookTrust(
    path: string,
    projectPath: string
): Promise<(hookId: string) => "allow" | "deny" | "pending"> {
    const records = new Map((await readDocument(path)).projects
        .filter(item => item.projectPath === projectPath)
        .map(item => [item.hookId, item.decision]));
    return hookId => records.get(hookId) ?? "pending";
}

export async function saveHookTrust(
    path: string,
    projectPath: string,
    hookIds: readonly string[],
    decision: Exclude<HookTrustDecision, "once">
): Promise<void> {
    if (!hookIds.length) return;
    const ids = new Set(hookIds);
    await ensureSafeParent(path);
    await withFileLock(`${path}.lock`, async () => {
        const document = await readDocument(path);
        const projects = document.projects.filter(
            (item) => item.projectPath !== projectPath || !ids.has(item.hookId)
        );
        const decidedAt = new Date().toISOString();
        for (const hookId of ids) projects.push({
            projectPath, hookId, decision: decision === "always" ? "allow" : "deny", decidedAt,
        });
        const updated = parseDocument({version: 2, projects});
        const content = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_HOOK_TRUST_FILE_BYTES) {
            throw new Error("Hook trust document exceeds the size limit");
        }
        await writeFileAtomically(path, content, 0o600);
    });
}
