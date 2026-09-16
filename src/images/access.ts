import type {Message} from "../llm/types.js";
import type {CompactState} from "../context/state.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import type {ToolResultStore} from "../toolResults/store.js";
import {SessionContentStore} from "../session/contentStore.js";
import {readArchiveMessages} from "../session/archive.js";
import {imageReferences, type ImageReference} from "./content.js";

export interface ImageAccess {
    find(imageId: string): ImageReference;
    read(reference: ImageReference): Promise<Buffer>;
    readSource(reference: ImageReference): Promise<Buffer>;
}

/** References come from the active branch, never by scanning the asset directory. */
export function createImageAccess(input: {
    storage: HiCodeStorageLayout; store: ToolResultStore;
    history: () => readonly Message[]; state: () => CompactState;
}): ImageAccess {
    const find = (imageId: string): ImageReference => {
        const live = input.history().flatMap(message => imageReferences(message.content)).find(ref => ref.imageId === imageId);
        if (live) return live;
        const blocks = new SessionContentStore(input.storage, input.store.cwd, input.store.sessionId);
        for (const record of input.state().archives ?? []) {
            const ref = readArchiveMessages(record, blocks).flatMap(message => imageReferences(message.content)).find(ref => ref.imageId === imageId);
            if (ref) return ref;
        }
        throw new Error("Image ID is not reachable in the current session/resumed branch");
    };
    function authorized(reference: ImageReference): ImageReference {
        const allowed = find(reference.imageId);
        if (JSON.stringify(allowed.image) !== JSON.stringify(reference.image)) throw new Error("Image reference metadata does not match");
        return allowed;
    }
    return {find,
        read: async reference => input.store.readImage(authorized(reference)),
        readSource: async reference => input.store.readImageSource(authorized(reference)),
    };
}
