import {realpath} from "node:fs/promises";
import {resolve} from "node:path";
import {readFileSnapshot} from "../tools/shared/fileSnapshot.js";
import {isPathInside} from "../permissions/pathGuard.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";

/** Already-authorized local selection. Resolve once, reject private storage, then open without following a leaf symlink. */
export async function readLocalImage(path: string, storage: HiCodeStorageLayout): Promise<Buffer> {
    const canonical = await realpath(path);
    if (canonical !== resolve(path)) throw new Error("Image path changed after authorization; select it again");
    const storageRoot = await realpath(storage.hicodeHome).catch(error => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return resolve(storage.hicodeHome);
        throw error;
    });
    if (isPathInside(storageRoot, canonical)) throw new Error("Images in managed storage must be read through an image_id in the current branch");
    return (await readFileSnapshot(canonical)).content;
}
