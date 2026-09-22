import {prepareFileCommit, type FileCommitCoordinator} from "./fileCommit.js";

/** File tools share the Root commit boundary without persisting file history. */
export async function commitFileWrite(input: {
    coordinator: FileCommitCoordinator;
    signal: AbortSignal;
    path: string;
    beforeContent: string | Buffer | null;
    afterContent: string | Buffer | null;
}): Promise<void> {
    return input.coordinator.run(input.path, input.signal, async canonical => {
        const commit = prepareFileCommit(input.path, canonical, input.beforeContent);
        await commit(input.afterContent, input.signal);
    });
}
