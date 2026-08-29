import {join} from "node:path";
import {getSessionStorageDirectory, hashProjectValue,} from "../persistence/index.js";

export function getToolResultSessionDir(
    cwd: string,
    sessionId: string,
    rootDir?: string
): string {
    return join(getSessionStorageDirectory(cwd, sessionId, rootDir), "tool-results");
}

export function getResultId(toolCallId: string): string {
    return `tr_${toolCallId}`;
}

export function getArtifactKey(sessionId: string, resultId: string): string {
    return hashProjectValue(`${sessionId}:${resultId}`, 32);
}
