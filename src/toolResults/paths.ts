import {join} from "node:path";
import {getSessionStorageDirectory, hashProjectValue, type HiCodeStorageLayout,} from "../persistence/index.js";

export function getToolResultSessionDir(
    storage: HiCodeStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(getSessionStorageDirectory(storage, cwd, sessionId), "tool-results");
}

export function getResultId(toolCallId: string): string {
    return `tr_${toolCallId}`;
}

export function getArtifactKey(sessionId: string, resultId: string): string {
    return hashProjectValue(`${sessionId}:${resultId}`, 32);
}
