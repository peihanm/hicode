import {chmod, lstat, mkdir, readFile, realpath} from "node:fs/promises";
import {dirname, join} from "node:path";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {HookTrustDecision} from "./types.js";

const MAX_HOOK_TRUST_FILE_BYTES = 1024 * 1024;
const MAX_HOOK_TRUST_PROJECTS = 10_000;
const MAX_HOOK_PROJECT_PATH_CHARACTERS = 16_384;

interface HookTrustRecord {
    projectPath: string;
    decision: "allow" | "deny";
    decidedAt: string;
}

interface HookTrustDocument {
    version: 1;
    projects: HookTrustRecord[];
}

function isErrorCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as {code?: string}).code === code
    );
}

function parseDocument(value: unknown): HookTrustDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Hook trust document 格式无效");
    }
    const document = value as Partial<HookTrustDocument>;
    if (
        Object.keys(document).some((key) => key !== "version" && key !== "projects") ||
        document.version !== 1 ||
        !Array.isArray(document.projects) ||
        document.projects.length > MAX_HOOK_TRUST_PROJECTS
    ) throw new Error("Hook trust document 格式无效");
    const projects: HookTrustRecord[] = [];
    const seen = new Set<string>();
    for (const item of document.projects) {
        if (
            !item || typeof item !== "object" || Array.isArray(item) ||
            Object.keys(item).some((key) =>
                key !== "projectPath" && key !== "decision" && key !== "decidedAt"
            ) ||
            typeof item.projectPath !== "string" ||
            item.projectPath.length === 0 ||
            item.projectPath.length > MAX_HOOK_PROJECT_PATH_CHARACTERS ||
            (item.decision !== "allow" && item.decision !== "deny") ||
            typeof item.decidedAt !== "string" ||
            !Number.isFinite(Date.parse(item.decidedAt)) ||
            seen.has(item.projectPath)
        ) throw new Error("Hook trust document 包含非法或重复项目记录");
        seen.add(item.projectPath);
        projects.push(item);
    }
    return {version: 1, projects};
}

async function readDocument(path: string): Promise<HookTrustDocument> {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error("Hook trust document 不是安全的 regular file");
        }
        if (info.size > MAX_HOOK_TRUST_FILE_BYTES) {
            throw new Error("Hook trust document 超过大小上限");
        }
        return parseDocument(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
            return {version: 1, projects: []};
        }
        throw error;
    }
}

async function ensureSafeParent(path: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Hook trust directory 不是安全的 directory");
    }
    await chmod(directory, 0o700);
}

export function getHookTrustPath(storage: PillarStorageLayout): string {
    return join(storage.pillarHome, "trusted-projects.json");
}

export async function canonicalHookProjectPath(cwd: string): Promise<string> {
    return realpath(cwd);
}

export async function getHookTrust(
    path: string,
    projectPath: string
): Promise<"allow" | "deny" | "pending"> {
    const record = (await readDocument(path)).projects.find(
        (item) => item.projectPath === projectPath
    );
    return record?.decision ?? "pending";
}

export async function saveHookTrust(
    path: string,
    projectPath: string,
    decision: Exclude<HookTrustDecision, "once">
): Promise<void> {
    await ensureSafeParent(path);
    await withFileLock(`${path}.lock`, async () => {
        const document = await readDocument(path);
        const projects = document.projects.filter(
            (item) => item.projectPath !== projectPath
        );
        projects.push({
            projectPath,
            decision: decision === "always" ? "allow" : "deny",
            decidedAt: new Date().toISOString(),
        });
        const updated = parseDocument({version: 1, projects});
        const content = `${JSON.stringify(updated, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_HOOK_TRUST_FILE_BYTES) {
            throw new Error("Hook trust document 超过大小上限");
        }
        await writeFileAtomically(path, content, 0o600);
    });
}
