import {existsSync, readFileSync} from "node:fs";
import {appendFile, chmod, mkdir} from "node:fs/promises";
import {dirname} from "node:path";
import {type PillarStorageLayout, withFileLock, writeFileAtomically,} from "../persistence/index.js";
import {isSessionSnapshotEntry, isSessionTurnCheckpointEntry,} from "./codec.js";
import {ensureSessionsDirectory, getSessionLogPath, getSessionPersistenceLockPath,} from "./paths.js";
import type {SessionEntry, SessionSnapshotEntry,} from "./types.js";

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
    await appendFile(
        path,
        `${JSON.stringify(entry)}\n`,
        {encoding: "utf8", mode: 0o600}
    );
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
    const entries = readSessionEntries(storage, cwd, sessionId)
        .filter((entry) => entry.type === "turn_checkpoint");
    const content = [...entries, snapshot]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    await writeFileAtomically(path, `${content}\n`, 0o600);
}

export function readSessionEntries(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): SessionEntry[] {
    const path = getSessionLogPath(storage, cwd, sessionId);
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
            // Ignore corrupt partial lines; prior valid entries remain recoverable.
        }
    }
    return entries;
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
