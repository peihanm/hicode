import {readFile, realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {withFileLock, writeFileAtomically} from "../persistence/index.js";
import type {HookTrustDecision} from "./types.js";

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
        return {version: 1, projects: []};
    }
    const document = value as Partial<HookTrustDocument>;
    const projects = Array.isArray(document.projects)
        ? document.projects.filter((item): item is HookTrustRecord =>
            Boolean(
                item &&
                typeof item === "object" &&
                typeof item.projectPath === "string" &&
                (item.decision === "allow" || item.decision === "deny") &&
                typeof item.decidedAt === "string"
            )
        )
        : [];
    return {version: 1, projects};
}

async function readDocument(path: string): Promise<HookTrustDocument> {
    try {
        return parseDocument(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
        if (isErrorCode(error, "ENOENT") || error instanceof SyntaxError) {
            return {version: 1, projects: []};
        }
        throw error;
    }
}

export function defaultHookTrustPath(): string {
    return join(homedir(), ".pillar", "trusted-projects.json");
}

export async function canonicalHookProjectPath(cwd: string): Promise<string> {
    try {
        return await realpath(cwd);
    } catch {
        return resolve(cwd);
    }
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
        await writeFileAtomically(
            path,
            `${JSON.stringify({version: 1, projects}, null, 2)}\n`
        );
    });
}
