import {createHash} from "node:crypto";
import {storedImageSchema, type StoredImage} from "./content.js";

export function imageAssetId(image: StoredImage): string {
    return `image-${createHash("sha256").update(JSON.stringify(storedImageSchema.parse(image))).digest("hex")}`;
}
