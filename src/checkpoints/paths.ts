import {createHash} from "node:crypto";
import {join} from "node:path";
import {getSessionStorageDirectory} from "../persistence/index.js";

export function getCheckpointDirectory(
    cwd: string,
    sessionId: string,
    projectsRoot?: string
): string {
    return join(getSessionStorageDirectory(cwd, sessionId, projectsRoot), "checkpoints");
}

export function getCheckpointManifestPath(directory: string): string {
    return join(directory, "manifest.json");
}

export function getCheckpointLockPath(directory: string): string {
    return join(directory, ".checkpoint.lock");
}

export function getCheckpointBlobPath(directory: string, blobId: string): string {
    return join(directory, "blobs", blobId);
}

function checkpointStorageKey(checkpointId: string): string {
    return createHash("sha256").update(checkpointId).digest("hex");
}

export function getCheckpointRecordPath(
    directory: string,
    checkpointId: string
): string {
    return join(directory, "records", `${checkpointStorageKey(checkpointId)}.json`);
}

export function getCheckpointMutationLogPath(
    directory: string,
    checkpointId: string
): string {
    return join(directory, "mutations", `${checkpointStorageKey(checkpointId)}.jsonl`);
}
