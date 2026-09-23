import {persistPreparedImage} from "./persist.js";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prepareImage} from "./prepare.js";
import {IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, type ContentPart, type MessageContent} from "./content.js";
import type {ToolResultStore} from "../toolResults/store.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

/** Host uploads bytes explicitly. Local paths are handled by the CLI selection boundary. */
export type TurnInput = string | readonly ({type: "text"; text: string} | {type: "image"; data: Uint8Array})[];
const inputSchema = z.union([
    z.string().min(1).max(1_000_000).refine(value => value.trim().length > 0),
    z.array(z.discriminatedUnion("type", [
        z.object({type: z.literal("text"), text: z.string().max(1_000_000)}).strict(),
        z.object({type: z.literal("image"), data: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 20 * 1024 * 1024)}).strict(),
    ])).min(1).max(32).refine(parts => parts.some(part => part.type === "image" || part.text.trim().length > 0))
        .refine(parts => parts.filter(part => part.type === "image").length <= IMAGE_MAX_COUNT)
        .refine(parts => parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0) <= 1_000_000)
        .refine(parts => parts.reduce((sum, part) => sum + (part.type === "image" ? part.data.byteLength : 0), 0) <= 40 * 1024 * 1024),
]);

/** Copy synchronously before the first await, so callers cannot mutate deferred input. */
export function snapshotTurnInput(input: TurnInput): TurnInput {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid multimodal input: provide non-empty text or static image bytes; at most 8 images, 20 MiB per image, 40 MiB total images and 1 million text characters");
    return typeof parsed.data === "string" ? parsed.data : parsed.data.map(part => part.type === "text" ? {...part} : {type: "image", data: Buffer.from(part.data)});
}

export async function importUserInput(input: TurnInput, store: ToolResultStore, supported: boolean, signal: AbortSignal): Promise<MessageContent> {
    throwIfTurnAborted(signal);
    if (typeof input === "string") return input;
    if (input.some(part => part.type === "image") && !supported) throw new Error("This model/interface does not support images; select a model configured with imageInput: true");
    const inputId = randomUUID();
    const parts: ContentPart[] = [];
    let bytes = 0;
    for (const part of input) {
        throwIfTurnAborted(signal);
        if (part.type === "text") {parts.push({...part}); continue;}
        const prepared = await prepareImage(Buffer.from(part.data), signal);
        bytes += prepared.data.length;
        if (bytes > IMAGE_REQUEST_BYTES) throw new Error("Normalized images exceed the 10 MiB input budget");
        const reference = await persistPreparedImage({store, origin: {kind: "user", inputId},
            sourceData: Buffer.from(part.data), prepared, signal});
        parts.push(reference);
    }
    throwIfTurnAborted(signal);
    return parts;
}
