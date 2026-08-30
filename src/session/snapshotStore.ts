import {existsSync, readFileSync, statSync} from "node:fs";
import {appendFile, chmod, mkdir} from "node:fs/promises";
import {dirname} from "node:path";
import {getProjectKey, type PillarStorageLayout, withFileLock, writeFileAtomically,} from "../persistence/index.js";
import {decodeSessionEntry} from "./codec.js";
import {ensureSessionsDirectory, getSessionLogPath, getSessionPersistenceLockPath,} from "./paths.js";
import type {SessionEntry, SessionSnapshotEntry,} from "./types.js";

const MAX_SESSION_LOG_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_LOG_ENTRIES = 4_096;
const MAX_SESSION_LOG_LINE_BYTES = 72 * 1024 * 1024;
const MAX_SESSION_TURN_CHECKPOINTS = 100;

export function withSessionPersistenceLock<T>(
    storage: PillarStorageLayout,
    cwd: string,
    action: () => Promise<T>
): Promise<T> {
    return withFileLock(getSessionPersistenceLockPath(storage, cwd), action);
}

export async function appendSessionEntry(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string,
    entry: SessionEntry
): Promise<void> {
    ensureSessionsDirectory(storage, cwd);
    const path = getSessionLogPath(storage, cwd, sessionId);
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    await chmod(dirname(path), 0o700);
    const decodedEntry = decodeSessionEntry(entry);
    if (!decodedEntry) {
        throw new Error(`Refusing to persist invalid session entry: ${path}`);
    }
    const existing = readSessionEntriesForMutation(storage, cwd, sessionId);
    let retainedEntries = existing.entries;
    let requiresRewrite = existing.requiresRewrite;
    if (decodedEntry.type === "turn_checkpoint") {
        let checkpointsToRemove = Math.max(
            0,
            retainedEntries.filter((candidate) => candidate.type === "turn_checkpoint").length -
            MAX_SESSION_TURN_CHECKPOINTS + 1
        );
        if (checkpointsToRemove > 0) {
            retainedEntries = retainedEntries.filter((candidate) => {
                if (candidate.type !== "turn_checkpoint" || checkpointsToRemove === 0) {
                    return true;
                }
                checkpointsToRemove -= 1;
                return false;
            });
            requiresRewrite = true;
        }
    }
    if (retainedEntries.length + 1 > MAX_SESSION_LOG_ENTRIES) {
        throw new Error(`Session log entry limit exceeded: ${path}`);
    }
    const line = `${JSON.stringify(decodedEntry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const currentBytes = existsSync(path) ? statSync(path).size : 0;
    if (lineBytes > MAX_SESSION_LOG_LINE_BYTES) {
        throw new Error(`Session log size limit exceeded: ${path}`);
    }
    if (requiresRewrite) {
        const content = [...retainedEntries, decodedEntry]
            .map((candidate) => JSON.stringify(candidate))
            .join("\n");
        if (Buffer.byteLength(content, "utf8") + 1 > MAX_SESSION_LOG_BYTES) {
            throw new Error(`Session log size limit exceeded: ${path}`);
        }
        await writeFileAtomically(path, `${content}\n`, 0o600);
    } else {
        if (currentBytes + lineBytes > MAX_SESSION_LOG_BYTES) {
            throw new Error(`Session log size limit exceeded: ${path}`);
        }
        await appendFile(
            path,
            line,
            {encoding: "utf8", mode: 0o600}
        );
    }
}

/** Keep rewind checkpoints plus one current-state snapshot. Caller holds the session lock. */
export async function replaceLatestSessionSnapshot(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string,
    snapshot: SessionSnapshotEntry
): Promise<void> {
    ensureSessionsDirectory(storage, cwd);
    const path = getSessionLogPath(storage, cwd, sessionId);
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    await chmod(dirname(path), 0o700);
    const decodedSnapshot = decodeSessionEntry(snapshot);
    if (!decodedSnapshot || decodedSnapshot.type !== "snapshot") {
        throw new Error(`Refusing to persist invalid session snapshot: ${path}`);
    }
    const entries = readSessionEntriesForMutation(storage, cwd, sessionId).entries
        .filter((entry) => entry.type === "turn_checkpoint")
        .slice(-MAX_SESSION_TURN_CHECKPOINTS);
    const content = [...entries, decodedSnapshot]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    if (Buffer.byteLength(content, "utf8") + 1 > MAX_SESSION_LOG_BYTES) {
        throw new Error(`Session log size limit exceeded: ${path}`);
    }
    await writeFileAtomically(path, `${content}\n`, 0o600);
}

function parseSessionEntries(input: {
    content: string;
    cwd: string;
    sessionId: string;
    path: string;
    strict: boolean;
}): SessionEntry[] {
    const lines = input.content.split("\n");
    const hasTrailingNewline = input.content.endsWith("\n");
    const entries: SessionEntry[] = [];
    let nonEmptyLines = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.trim()) continue;
        nonEmptyLines += 1;
        if (
            nonEmptyLines > MAX_SESSION_LOG_ENTRIES ||
            Buffer.byteLength(line, "utf8") > MAX_SESSION_LOG_LINE_BYTES
        ) {
            if (input.strict) {
                throw new Error(`Session log limit exceeded: ${input.path}`);
            }
            return [];
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            const isPartialTail = index === lines.length - 1 && !hasTrailingNewline;
            if (isPartialTail) break;
            if (input.strict) {
                throw new Error(`Cannot update corrupt session log: ${input.path}`, {
                    cause: error,
                });
            }
            continue;
        }
        const entry = decodeSessionEntry(parsed);
        if (
            !entry ||
            getProjectKey(entry.cwd) !== getProjectKey(input.cwd) ||
            entry.sessionId !== input.sessionId
        ) {
            if (input.strict) {
                throw new Error(`Cannot update invalid session log: ${input.path}`);
            }
            continue;
        }
        entries.push(entry);
    }
    return entries;
}

function readSessionEntriesForMutation(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): {entries: SessionEntry[]; requiresRewrite: boolean} {
    const path = getSessionLogPath(storage, cwd, sessionId);
    if (!existsSync(path)) return {entries: [], requiresRewrite: false};
    const size = statSync(path).size;
    if (size > MAX_SESSION_LOG_BYTES) {
        throw new Error(`Session log size limit exceeded: ${path}`);
    }
    const content = readFileSync(path, "utf8");
    return {
        entries: parseSessionEntries({
            content,
            cwd,
            sessionId,
            path,
            strict: true,
        }),
        requiresRewrite: content.length > 0 && !content.endsWith("\n"),
    };
}

export function readSessionEntries(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): SessionEntry[] {
    const path = getSessionLogPath(storage, cwd, sessionId);
    if (!existsSync(path)) return [];
    try {
        if (statSync(path).size > MAX_SESSION_LOG_BYTES) return [];
        return parseSessionEntries({
            content: readFileSync(path, "utf8"),
            cwd,
            sessionId,
            path,
            strict: false,
        });
    } catch {
        return [];
    }
}

export function readLatestSessionSnapshot(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): SessionSnapshotEntry | null {
    let latest: SessionSnapshotEntry | null = null;
    for (const entry of readSessionEntries(storage, cwd, sessionId)) {
        if (entry.type === "snapshot") latest = entry;
    }
    return latest;
}
