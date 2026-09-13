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
    cwd: string,
    sessionId: string
): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), ".persistence.lock");
}

export function getSessionSnapshotPath(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "snapshot.json");
}

export function ensureSessionsDirectory(
    storage: PillarStorageLayout,
    cwd: string
): void {
    const directory = getProjectSessionsDirectory(storage, cwd);
    ensurePrivateStorageDirectory(storage, directory);
}

export function getSessionIndexLockPath(storage:PillarStorageLayout,cwd:string):string {return join(getProjectSessionsDirectory(storage,cwd),".index.lock");}
