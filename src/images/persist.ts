import type {ToolResultStore} from "../toolResults/store.js";
import type {BinaryArtifactOrigin} from "../toolResults/types.js";
import type {ImageDescriptor, ImageReference} from "./content.js";
import {imageAssetId} from "./identity.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

// Source first, view second, reference last: failure never publishes a partial dependency.
export async function persistPreparedImage(input: {
    store: ToolResultStore; origin: BinaryArtifactOrigin; sourceData: Buffer;
    prepared: {data: Buffer; image: ImageDescriptor}; signal: AbortSignal;
}): Promise<ImageReference> {
    const {store, origin, prepared, sourceData, signal} = input;
    throwIfTurnAborted(signal);
    const source = prepared.image.source;
    await store.persistBinary({origin, artifactId: imageAssetId(source), data: sourceData, mimeType: source.mimeType, image: source});
    const imageId = imageAssetId(prepared.image);
    await store.persistBinary({origin, artifactId: imageId, ...prepared, mimeType: prepared.image.mimeType});
    const reference: ImageReference = {type: "image", imageId, image: prepared.image};
    await store.readImageSource(reference);
    await store.readImage(reference);
    throwIfTurnAborted(signal);
    return reference;
}
