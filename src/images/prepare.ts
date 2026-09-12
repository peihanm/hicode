import {createHash} from "node:crypto";
import sharp from "sharp";
import {throwIfTurnAborted} from "../runtime/abort.js";
import {IMAGE_MAX_BYTES, imageDescriptorSchema, imageSourceSchema, imageRegionSchema, type ImageDescriptor, type ImageRegion} from "./content.js";

// libvips exposes pages for WebP, but can treat APNG as its first PNG frame.
function rejectAnimatedPng(input: Buffer): void {
    if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
    let offset = 8;
    let chunks = 0;
    while (offset + 12 <= input.length) {
        if (++chunks > 100_000) throw new Error("PNG chunk count exceeds the safety limit");
        const size = input.readUInt32BE(offset);
        if (offset + size + 12 > input.length) throw new Error("Incomplete PNG chunk");
        const type = input.toString("ascii", offset + 4, offset + 8);
        if (type === "acTL") throw new Error("Only static PNG is supported; APNG animation is not supported");
        offset += size + 12;
        if (type === "IEND") break;
    }
}

/** Each invocation owns its decoder; no global cache or sharp settings are changed. */
export async function prepareImage(input: Buffer, signal: AbortSignal, region?: ImageRegion): Promise<{data: Buffer; image: ImageDescriptor}> {
    throwIfTurnAborted(signal);
    if (input.length === 0 || input.length > 20 * 1024 * 1024) throw new Error("Image must be between 1 byte and 20 MiB");
    rejectAnimatedPng(input);
    const decoder = sharp(input, {limitInputPixels: 40_000_000, failOn: "warning"}).timeout({seconds: 10});
    const cancel = () => decoder.destroy();
    signal.addEventListener("abort", cancel, {once: true});
    try {
        const metadata = await decoder.metadata();
        if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) {
            throw new Error("Only static PNG/JPEG/WebP is supported; animations, GIF, SVG, HEIC and PDF are not supported");
        }
        if (!metadata.width || !metadata.height) throw new Error("Cannot determine image dimensions");
        throwIfTurnAborted(signal);
        const orientation = metadata.orientation ?? 1;
        const swapped = orientation >= 5;
        const source = imageSourceSchema.parse({kind: "source", version: 1,
            sha256: createHash("sha256").update(input).digest("hex"), byteLength: input.length,
            mimeType: metadata.format === "jpeg" ? "image/jpeg" : metadata.format === "webp" ? "image/webp" : "image/png",
            width: swapped ? metadata.height : metadata.width, height: swapped ? metadata.width : metadata.height, orientation});
        const selected = imageRegionSchema.parse(region ?? {x: 0, y: 0, width: source.width, height: source.height});
        if (selected.x + selected.width > source.width || selected.y + selected.height > source.height)
            throw new Error("Crop region exceeds the oriented original image dimensions");
        const pipeline = decoder.autoOrient().extract({left: selected.x, top: selected.y, width: selected.width, height: selected.height}).resize({width: 2048, height: 2048, fit: "inside", withoutEnlargement: true});
        // Preserve alpha and screenshot text losslessly. JPEG input stays JPEG.
        const jpeg = metadata.format === "jpeg" && !metadata.hasAlpha;
        const {data, info} = await (jpeg ? pipeline.jpeg({quality: 90}) : pipeline.png()).toBuffer({resolveWithObject: true});
        throwIfTurnAborted(signal);
        if (data.length > IMAGE_MAX_BYTES) throw new Error("Normalized image exceeds 2 MiB; provide a smaller image");
        const image = imageDescriptorSchema.parse({kind: "view", version: 2, sha256: createHash("sha256").update(data).digest("hex"),
            mimeType: jpeg ? "image/jpeg" : "image/png", byteLength: data.length, width: info.width, height: info.height,
            sourceWidth: source.width, sourceHeight: source.height, source, region: selected});
        return {data, image};
    } finally {
        signal.removeEventListener("abort", cancel);
        decoder.destroy();
    }
}
