import {z} from "zod";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 8;
export const IMAGE_REQUEST_BYTES = 10 * 1024 * 1024;
// Conservative local estimate; not a supplier token formula or billable usage.
export const IMAGE_ESTIMATED_TOKENS = 8192;

export const imageDescriptorSchema = z.object({
    version: z.literal(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(["image/png", "image/jpeg"]),
    byteLength: z.number().int().positive().max(IMAGE_MAX_BYTES),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    sourceWidth: z.number().int().positive().max(40_000_000),
    sourceHeight: z.number().int().positive().max(40_000_000),
}).strict().refine(value => value.sourceWidth * value.sourceHeight <= 40_000_000);
export type ImageDescriptor = z.infer<typeof imageDescriptorSchema>;
export const imageReferenceSchema = z.object({
    type: z.literal("image"),
    imageId: z.string().regex(/^image-[a-f0-9]{64}$/),
    label: z.string().min(1).max(256).optional(),
    image: imageDescriptorSchema,
}).strict();
export type ImageReference = z.infer<typeof imageReferenceSchema>;
export type ContentPart = {type: "text"; text: string} | ImageReference;
export const messageContentSchema = z.union([z.string().max(1_000_000), z.array(z.union([
    z.object({type: z.literal("text"), text: z.string().max(1_000_000)}).strict(), imageReferenceSchema,
])).min(1).max(32)]);
export type MessageContent = string | ContentPart[];

/** Text projection for UI, hooks and summaries, never a claim that pixels were seen. */
export function contentText(content: MessageContent | null | undefined): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    return content.map(part => part.type === "text" ? part.text
        : `[图片 ${part.imageId}; ${part.image.mimeType}; ${part.image.width}×${part.image.height}; ${part.image.byteLength} bytes；此文字投影不含像素，需要 view_image(image_id) 重看]`).join("\n");
}

export function imageReferences(content: MessageContent | null): ImageReference[] {
    return Array.isArray(content) ? content.filter((part): part is ImageReference => part.type === "image") : [];
}

export function appendContentText(content: MessageContent, text: string): MessageContent {
    return typeof content === "string" ? `${content}\n\n${text}` : [...content, {type: "text", text}];
}

export function replaceContentText(content: MessageContent, text: string): MessageContent {
    if (typeof content === "string") return text;
    let replaced = false;
    const parts = content.flatMap<ContentPart>(part => {
        if (part.type === "image") return [part];
        if (replaced) return [];
        replaced = true;
        return [{type: "text", text}];
    });
    return replaced ? parts : [{type: "text", text}, ...parts];
}
