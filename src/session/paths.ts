import {mkdirSync} from "node:fs";
import {join} from "node:path";

function getSessionsDirectory(cwd: string): string {
    return join(cwd, ".pillar", "sessions");
}

export function getSessionIndexPath(cwd: string): string {
    return join(getSessionsDirectory(cwd), "index.json");
}

export function getSessionPersistenceLockPath(cwd: string): string {
    return join(getSessionsDirectory(cwd), ".persistence.lock");
}

export function getSessionLogPath(cwd: string, sessionId: string): string {
    return join(getSessionsDirectory(cwd), `${sessionId}.jsonl`);
}

export function ensureSessionsDirectory(cwd: string): void {
    mkdirSync(getSessionsDirectory(cwd), {recursive: true});
}
