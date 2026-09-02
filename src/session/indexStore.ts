import {
    readPrivateStorageTextFile,
    type PillarStorageLayout,
    writeFileAtomically,
} from "../persistence/index.js";
import {decodeSessionIndexEntries} from "./codec.js";
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

const MAX_SESSION_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_INDEX_ENTRIES = 10_000;

function emptySessionIndex(): SessionIndexFile {
    return {version: SESSION_INDEX_VERSION, sessions: []};
}

/** Read-only callers treat a missing or invalid index as an empty picker. */
export function readSessionIndex(
    storage: PillarStorageLayout,
    cwd: string
): SessionIndexFile {
    const path = getSessionIndexPath(storage, cwd);
    try {
        const content = readPrivateStorageTextFile(
            storage,
            path,
            MAX_SESSION_INDEX_BYTES
        );
        if (content === null) return emptySessionIndex();
        const parsed = JSON.parse(content) as Partial<SessionIndexFile>;
        if (
            parsed.version !== SESSION_INDEX_VERSION ||
            !Array.isArray(parsed.sessions)
        ) {
            return emptySessionIndex();
        }
        const sessions = decodeSessionIndexEntries(parsed.sessions, cwd);
        return sessions
            ? {version: parsed.version, sessions}
            : emptySessionIndex();
    } catch {
        return emptySessionIndex();
    }
}

async function readSessionIndexForMutation(
    storage: PillarStorageLayout,
    cwd: string
): Promise<SessionIndexFile> {
    const path = getSessionIndexPath(storage, cwd);
    const content = readPrivateStorageTextFile(
        storage,
        path,
        MAX_SESSION_INDEX_BYTES
    );
    if (content === null) return emptySessionIndex();

    try {
        const parsed = JSON.parse(content) as Partial<SessionIndexFile>;
        if (
            parsed.version !== SESSION_INDEX_VERSION ||
            !Array.isArray(parsed.sessions)
        ) {
            throw new Error(`Unsupported session index format: ${path}`);
        }
        const sessions = decodeSessionIndexEntries(parsed.sessions, cwd);
        if (!sessions) throw new Error(`Invalid session index entries: ${path}`);
        return {version: parsed.version, sessions};
    } catch (error) {
        throw new Error(`Cannot update corrupt session index: ${path}`, {
            cause: error,
        });
    }
}

async function writeSessionIndex(
    storage: PillarStorageLayout,
    cwd: string,
    index: SessionIndexFile
): Promise<void> {
    ensureSessionsDirectory(storage, cwd);
    const sessions = [...index.sessions].sort(
        (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime()
    );
    if (sessions.length > MAX_SESSION_INDEX_ENTRIES) {
        throw new Error(`Session index entry limit exceeded: ${cwd}`);
    }
    const content = `${JSON.stringify({
        version: SESSION_INDEX_VERSION,
        sessions,
    }, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_SESSION_INDEX_BYTES) {
        throw new Error(`Session index size limit exceeded: ${cwd}`);
    }
    await writeFileAtomically(
        getSessionIndexPath(storage, cwd),
        content,
        0o600
    );
}

export async function upsertSessionIndex(
    storage: PillarStorageLayout,
    input: UpsertSessionIndexInput
): Promise<void> {
    const index = await readSessionIndexForMutation(storage, input.cwd);
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
    await writeSessionIndex(storage, input.cwd, {
        version: SESSION_INDEX_VERSION,
        sessions,
    });
}
