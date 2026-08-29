import {existsSync, readFileSync} from "node:fs";
import {appendFile} from "node:fs/promises";
import {withFileLock} from "../persistence/index.js";
import {isSessionSnapshotEntry, isSessionTurnCheckpointEntry,} from "./codec.js";
import {ensureSessionsDirectory, getSessionLogPath, getSessionPersistenceLockPath,} from "./paths.js";
import type {SessionEntry, SessionSnapshotEntry,} from "./types.js";

export function withSessionPersistenceLock<T>(
    cwd: string,
    action: () => Promise<T>
): Promise<T> {
    return withFileLock(getSessionPersistenceLockPath(cwd), action);
}

export async function appendSessionEntry(
    cwd: string,
    sessionId: string,
    entry: SessionEntry
): Promise<void> {
    ensureSessionsDirectory(cwd);
    await appendFile(
        getSessionLogPath(cwd, sessionId),
        `${JSON.stringify(entry)}\n`,
        "utf8"
    );
}

export function readSessionEntries(
    cwd: string,
    sessionId: string
): SessionEntry[] {
    const path = getSessionLogPath(cwd, sessionId);
    if (!existsSync(path)) return [];
    const entries: SessionEntry[] = [];
    for (const line of readFileSync(path, "utf8").split(/\n+/)) {
        if (!line.trim()) continue;
        try {
            const entry: unknown = JSON.parse(line);
            if (
                isSessionSnapshotEntry(entry) ||
                isSessionTurnCheckpointEntry(entry)
            ) {
                entries.push(entry);
            }
        } catch {
            // Ignore corrupt partial lines. Append-only logs remain recoverable.
        }
    }
    return entries;
}

export function readLatestSessionSnapshot(
    cwd: string,
    sessionId: string
): SessionSnapshotEntry | null {
    let latest: SessionSnapshotEntry | null = null;
    for (const entry of readSessionEntries(cwd, sessionId)) {
        if (entry.type === "snapshot") latest = entry;
    }
    return latest;
}
