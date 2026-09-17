import type {Message} from "../llm/types.js";
import {IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, type ContentPart, type ImageReference} from "./content.js";

function withoutPixels(reference: ImageReference, deferred: boolean): ContentPart {
    const reason = deferred
        ? "Pixels were NOT sent: this batch exceeds the request image budget (8 images / 10 MiB). Request this snapshot separately; do not infer its contents."
        : "Pixels are omitted from this request; retain earlier textual observations, not an assumption of current visual access.";
    return {type: "text", text: `[Image ${reference.imageId}; ${reason} Use view_image with image_id to inspect the stored snapshot again.]`};
}

/** Request-only projection. History and asset reachability remain unchanged.
 * A committed assistant response closes the preceding image input. Without
 * that response, failed/cancelled requests still have their pending pixels.
 */
export function projectImagesForRequest(messages: readonly Message[]): Message[] {
    const boundary = messages.findLastIndex(message => message.role === "assistant");
    let count = 0;
    let bytes = 0;
    const projected = [...messages];
    // Prefer newest views when one fresh batch alone exceeds the wire budget.
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]!;
        if ((message.role !== "user" && message.role !== "tool") || !Array.isArray(message.content)) continue;
        const content = [...message.content];
        for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
            const part = content[partIndex]!;
            if (part.type !== "image") continue;
            const pending = index > boundary && !part.referenceOnly;
            if (pending && count < IMAGE_MAX_COUNT && bytes + part.image.byteLength <= IMAGE_REQUEST_BYTES) {
                count++;
                bytes += part.image.byteLength;
            } else content[partIndex] = withoutPixels(part, pending);
        }
        projected[index] = {...message, content};
    }
    return projected;
}

/** Preserve the response boundary on references when compaction removes turns. */
export function retainImageDeliveryBoundary(messages: readonly Message[]): Message[] {
    const boundary = messages.findLastIndex(message => message.role === "assistant");
    return messages.map((message, index) => {
        if (index > boundary || (message.role !== "user" && message.role !== "tool") || !Array.isArray(message.content)) return message;
        return {...message, content: message.content.map(part => part.type === "image"
            ? {...part, referenceOnly: true as const} : part)};
    });
}
