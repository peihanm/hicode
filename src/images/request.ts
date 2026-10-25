import {createHash} from "node:crypto";
import type {Message, LLMSourceConnection} from "../llm/types.js";
import {IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, imageReferences, imageReferenceSchema} from "./content.js";
import type {ContentPart, ImageReference} from "./content.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

/** An explicit model declaration authorizes image encoding; protocol compatibility alone does not. */
export function supportsToolImages(source: LLMSourceConnection, model: string): boolean {
    return source.models?.find(candidate => candidate.id === model)?.imageInput === true;
}

function withoutPixels(reference: ImageReference, deferred: boolean): ContentPart {
    const reason = deferred
        ? "Pixels were NOT sent: this batch exceeds the request image budget (8 images / 10 MiB). Request this snapshot separately; do not infer its contents."
        : "Historical image reference: this request contains only a text reference, without pixels, after an earlier response. This is not a new viewing result or a budget-deferral notice, and does not imply that the earlier view failed or image support is unavailable. Retain earlier recorded observations; reopen only when visual detail is needed.";
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

/** Safe, local preparation diagnostics; never include image bytes or data URLs. */
export class ImageRequestError extends Error {
    override name = "ImageRequestError";
}

/** Project internal provenance away while preserving the provider's reasoning field. */
export function projectMessageForWire(message: Message) {
    if (message.role === "user") return {role: message.role, content: message.content};
    if (message.role === "assistant") {
        const {reasoning, ...visible} = message;
        if (reasoning && "format" in reasoning) {
            return {...visible,
                ...(reasoning.content ? {reasoning: reasoning.content} : {}),
                ...(reasoning.details.length ? {reasoning_details: reasoning.details} : {}),
            };
        }
        return {...visible, ...(reasoning ? {reasoning_content: reasoning.content} : {})};
    }
    return message;
}

export async function encodeImageMessages(input: {
    messages: readonly Message[]; supported: boolean;
    readImage?: (reference: ImageReference) => Promise<Buffer>; signal?: AbortSignal;
}): Promise<unknown[]> {
    const references = input.messages.flatMap(message => imageReferences(message.content));
    if (references.length) {
        if (!input.supported || !input.readImage) throw new ImageRequestError("This model/interface or Session has no image capability; history is preserved and the request was not sent");
        const seen = new Map<string, string>();
        for (const reference of references) {
            if (!imageReferenceSchema.safeParse(reference).success) throw new ImageRequestError("Invalid image reference metadata; request was not sent");
            const descriptor = JSON.stringify(reference.image);
            if (seen.has(reference.imageId) && seen.get(reference.imageId) !== descriptor) throw new ImageRequestError("Inconsistent metadata for the same image ID");
            seen.set(reference.imageId, descriptor);
        }
        if (references.length > IMAGE_MAX_COUNT || references.reduce((sum, ref) => sum + ref.image.byteLength, 0) > IMAGE_REQUEST_BYTES) {
            throw new ImageRequestError("Request exceeds 8 images or 10 MiB; request image projection must reduce the pixel payload before encoding");
        }
    }
    const cache = new Map<string, string>();
    const messages: unknown[] = [];
    for (const message of input.messages) {
        const wireMessage = projectMessageForWire(message);
        if (input.signal) throwIfTurnAborted(input.signal);
        if (!Array.isArray(message.content)) {messages.push(wireMessage); continue;}
        const content: unknown[] = [];
        for (const part of message.content) {
            if (part.type === "text") {content.push(part); continue;}
            let url = cache.get(part.imageId);
            if (!url) {
                const data = await input.readImage!(part);
                if (data.length !== part.image.byteLength || createHash("sha256").update(data).digest("hex") !== part.image.sha256) throw new ImageRequestError("Model-input image integrity check failed");
                url = `data:${part.image.mimeType};base64,${data.toString("base64")}`;
                cache.set(part.imageId, url);
            }
            content.push({type: "image_url", image_url: {url}});
        }
        messages.push({...wireMessage, content});
    }
    if (input.signal) throwIfTurnAborted(input.signal);
    return messages;
}
