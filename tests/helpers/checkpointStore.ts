import {join} from "node:path";
import {FileCheckpointStore} from "../../src/checkpoints/store.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

export function createTestFileCheckpointStore(
    cwd: string,
    sessionId: string
): FileCheckpointStore {
    return FileCheckpointStore.create(
        createPillarStorageLayout({
            pillarHome: join(cwd, ".pillar-test-checkpoints"),
        }),
        cwd,
        sessionId
    );
}
