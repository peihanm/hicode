import {existsSync, readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {writeFileAtomically} from "../persistence/index.js";
import {ensureSessionsDirectory, getSessionIndexPath} from "./paths.js";
import {SESSION_INDEX_VERSION, type SessionIndexEntry, type SessionIndexFile,} from "./types.js";

interface UpsertSessionIndexInput {
    cwd: string;
    sessionId: string;
    model: string;
    timestamp: string;
    messageCount: number;
    firstPrompt?: string;
    lastPrompt?: string;
    summary?: string;
}

function emptySessionIndex(): SessionIndexFile {
    return {version: SESSION_INDEX_VERSION, sessions: []};
}

/** Read-only callers treat a missing or invalid index as an empty picker. */
export function readSessionIndex(cwd: string): SessionIndexFile {
    const path = getSessionIndexPath(cwd);
    if (!existsSync(path)) return emptySessionIndex();

    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionIndexFile>;
        if (
            parsed.version !== SESSION_INDEX_VERSION ||
            !Array.isArray(parsed.sessions)
        ) {
            return emptySessionIndex();
        }
        return {version: parsed.version, sessions: parsed.sessions};
    } catch {
        return emptySessionIndex();
    }
}

async function readSessionIndexForMutation(cwd: string): Promise<SessionIndexFile> {
    const path = getSessionIndexPath(cwd);
    let content: string;
    try {
        content = await readFile(path, "utf8");
    } catch (error) {
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "ENOENT"
        ) {
            return emptySessionIndex();
        }
        throw error;
    }

    try {
        const parsed = JSON.parse(content) as Partial<SessionIndexFile>;
        if (
            parsed.version !== SESSION_INDEX_VERSION ||
            !Array.isArray(parsed.sessions)
        ) {
            throw new Error(`Unsupported session index format: ${path}`);
        }
        return {version: parsed.version, sessions: parsed.sessions};
    } catch (error) {
        throw new Error(`Cannot update corrupt session index: ${path}`, {
            cause: error,
        });
    }
}

async function writeSessionIndex(
    cwd: string,
    index: SessionIndexFile
): Promise<void> {
    ensureSessionsDirectory(cwd);
    const sessions = [...index.sessions].sort(
        (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime()
    );
    await writeFileAtomically(
        getSessionIndexPath(cwd),
        `${JSON.stringify({version: SESSION_INDEX_VERSION, sessions}, null, 2)}\n`
    );
}

export async function upsertSessionIndex(
    input: UpsertSessionIndexInput
): Promise<void> {
    const index = await readSessionIndexForMutation(input.cwd);
    const existing = index.sessions.find(
        (entry) => entry.sessionId === input.sessionId
    );
    const next: SessionIndexEntry = {
        sessionId: input.sessionId,
        cwd: input.cwd,
        model: input.model,
        createdAt: existing?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
        messageCount: input.messageCount,
        archived: existing?.archived,
        firstPrompt: existing?.firstPrompt ?? input.firstPrompt,
        lastPrompt: input.lastPrompt ?? existing?.lastPrompt,
        summary: input.summary ?? existing?.summary,
    };
    const sessions = existing
        ? index.sessions.map((entry) =>
            entry.sessionId === input.sessionId ? next : entry
        )
        : [...index.sessions, next];
    await writeSessionIndex(input.cwd, {
        version: SESSION_INDEX_VERSION,
        sessions,
    });
}
