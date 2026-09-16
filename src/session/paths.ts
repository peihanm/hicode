import {join} from "node:path";
import {
    ensurePrivateStorageDirectory,
    getProjectSessionsDirectory,
    getSessionStorageDirectory,
    type HiCodeStorageLayout,
} from "../persistence/index.js";

export function getSessionIndexPath(
    storage: HiCodeStorageLayout,
    cwd: string
): string {
    return join(getProjectSessionsDirectory(storage, cwd), "index.json");
}

export function getSessionPersistenceLockPath(
    storage: HiCodeStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), ".persistence.lock");
}

export function getSessionSnapshotPath(
    storage: HiCodeStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "snapshot.json");
}

export function ensureSessionsDirectory(
    storage: HiCodeStorageLayout,
    cwd: string
): void {
    const directory = getProjectSessionsDirectory(storage, cwd);
    ensurePrivateStorageDirectory(storage, directory);
}

export function getSessionIndexLockPath(storage:HiCodeStorageLayout,cwd:string):string {return join(getProjectSessionsDirectory(storage,cwd),".index.lock");}
