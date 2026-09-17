import {createHash} from "node:crypto";
import type {Message} from "../llm/types.js";
import {imageReferences, imageReferenceSchema, IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, type ImageReference} from "./content.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

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
