import {join} from "node:path";
import {
    ensurePrivateStorageDirectory,
    getProjectSessionsDirectory,
    getSessionStorageDirectory,
    type PillarStorageLayout,
} from "../persistence/index.js";

export function getSessionIndexPath(
    storage: PillarStorageLayout,
    cwd: string
): string {
    return join(getProjectSessionsDirectory(storage, cwd), "index.json");
}

export function getSessionPersistenceLockPath(
    storage: PillarStorageLayout,
    cwd: string
): string {
    return join(getProjectSessionsDirectory(storage, cwd), ".persistence.lock");
}

export function getSessionLogPath(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "events.jsonl");
}

export function ensureSessionsDirectory(
    storage: PillarStorageLayout,
    cwd: string
): void {
    const directory = getProjectSessionsDirectory(storage, cwd);
    ensurePrivateStorageDirectory(storage, directory);
}
