import {z} from "zod";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 8;
export const IMAGE_REQUEST_BYTES = 10 * 1024 * 1024;
// Conservative local estimate; not a supplier token formula or billable usage.
export const IMAGE_ESTIMATED_TOKENS = 8192;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const imageRegionSchema = z.object({
    x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
export type ImageRegion = z.infer<typeof imageRegionSchema>;
export const imageSourceSchema = z.object({
    kind: z.literal("source"), version: z.literal(1), sha256: hash,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().positive().max(20 * 1024 * 1024),
    width: z.number().int().positive().max(40_000_000),
    height: z.number().int().positive().max(40_000_000),
    orientation: z.number().int().min(1).max(8),
}).strict().refine(value => value.width * value.height <= 40_000_000);
export const imageDescriptorSchema = z.object({
    kind: z.literal("view"), version: z.literal(2), sha256: hash,
    mimeType: z.enum(["image/png", "image/jpeg"]),
    byteLength: z.number().int().positive().max(IMAGE_MAX_BYTES),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    sourceWidth: z.number().int().positive().max(40_000_000),
    sourceHeight: z.number().int().positive().max(40_000_000),
    source: imageSourceSchema,
    region: imageRegionSchema,
}).strict().refine(value => value.sourceWidth === value.source.width && value.sourceHeight === value.source.height &&
    value.region.x + value.region.width <= value.source.width && value.region.y + value.region.height <= value.source.height);
export type ImageDescriptor = z.infer<typeof imageDescriptorSchema>;
export const storedImageSchema = z.union([imageDescriptorSchema, imageSourceSchema]);
export type StoredImage = z.infer<typeof storedImageSchema>;
export const imageReferenceSchema = z.object({
    type: z.literal("image"),
    imageId: z.string().regex(/^image-[a-f0-9]{64}$/),
    label: z.string().min(1).max(256).optional(),
    // Compaction may remove the assistant reply that closed this image input.
    referenceOnly: z.literal(true).optional(),
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
        : `[Image ${part.imageId}; ${part.image.mimeType}; ${part.image.width}×${part.image.height}; ${part.image.byteLength} bytes; original ${part.image.sourceWidth}×${part.image.sourceHeight}; region x=${part.image.region.x},y=${part.image.region.y},w=${part.image.region.width},h=${part.image.region.height}; this text projection has no pixels; use view_image(image_id) to view it again]`).join("\n");
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
