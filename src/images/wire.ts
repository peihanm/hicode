import {createHash} from "node:crypto";
import type {Message} from "../llm/types.js";
import {imageReferences, imageReferenceSchema, IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, type ImageReference} from "./content.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

export async function encodeImageMessages(input: {
    messages: readonly Message[]; supported: boolean;
    readImage?: (reference: ImageReference) => Promise<Buffer>; signal?: AbortSignal;
}): Promise<unknown[]> {
    const references = input.messages.flatMap(message => imageReferences(message.content));
    if (references.length) {
        if (!input.supported || !input.readImage) throw new Error("当前模型/接口或 Session 未提供图片能力；历史保留，未发送请求");
        const seen = new Map<string, string>();
        for (const reference of references) {
            imageReferenceSchema.parse(reference);
            const descriptor = JSON.stringify(reference.image);
            if (seen.has(reference.imageId) && seen.get(reference.imageId) !== descriptor) throw new Error("同一图片 ID 的元数据不一致");
            seen.set(reference.imageId, descriptor);
        }
        if (references.length > IMAGE_MAX_COUNT || references.reduce((sum, ref) => sum + ref.image.byteLength, 0) > IMAGE_REQUEST_BYTES) {
            throw new Error("当前请求图片超过 8 张或 10 MiB 预算；请先压缩历史或减少图片，不会静默丢图");
        }
    }
    const cache = new Map<string, string>();
    const messages: unknown[] = [];
    for (const message of input.messages) {
        if (input.signal) throwIfTurnAborted(input.signal);
        if (!Array.isArray(message.content)) {messages.push(message); continue;}
        const content: unknown[] = [];
        for (const part of message.content) {
            if (part.type === "text") {content.push(part); continue;}
            let url = cache.get(part.imageId);
            if (!url) {
                const data = await input.readImage!(part);
                if (data.length !== part.image.byteLength || createHash("sha256").update(data).digest("hex") !== part.image.sha256) throw new Error("送模图片完整性校验失败");
                url = `data:${part.image.mimeType};base64,${data.toString("base64")}`;
                cache.set(part.imageId, url);
            }
            content.push({type: "image_url", image_url: {url}});
        }
        messages.push({...message, content});
    }
    if (input.signal) throwIfTurnAborted(input.signal);
    return messages;
}
