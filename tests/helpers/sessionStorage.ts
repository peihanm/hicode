import {createSessionPersistence} from "../../src/session/storage.js";
import type {HiCodeStorageLayout} from "../../src/persistence/layout.js";
import type {SaveSessionSnapshotInput} from "../../src/session/types.js";
import type {SessionArchiveDraft} from "../../src/session/archive.js";

// One-shot fixture writes intentionally have no live Session owner.
export function saveSessionSnapshot(storage: HiCodeStorageLayout, input: SaveSessionSnapshotInput): Promise<void> {
    return createSessionPersistence(storage, input.cwd, input.sessionId).save(input);
}
export function saveSessionCompaction(storage: HiCodeStorageLayout, input: SaveSessionSnapshotInput, draft: SessionArchiveDraft, signal: AbortSignal): Promise<void> {
    return createSessionPersistence(storage, input.cwd, input.sessionId).compact(input, draft, signal);
}
