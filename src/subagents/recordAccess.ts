import {isPathInside} from "../permissions/pathGuard.js";
import {resolveFilePermissionPath} from "../permissions/filePattern.js";
import {basename, dirname, isAbsolute, relative, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import type {HiCodeStorageLayout} from "../persistence/layout.js";
import {hasFileSystemErrorCode} from "../persistence/errors.js";

const recordPattern = /(?:^|\/)sessions\/session-[^/]+\/subagents\/[^/]+\/(?:state\.json|events\.jsonl|conversation\.txt)$/;

export interface SubagentRecordAccess {
    resolve(path: string): Promise<{path: string; byteLength: number; complete: boolean}>;
}

function isRecordPath(root: string, path: string): boolean {
    const rel = relative(root, path);
    return !isAbsolute(rel) && !rel.startsWith("..") && recordPattern.test(rel);
}

/** An alias must not turn a managed child record into an ordinary source read. */
export async function checkSubagentRecordPath(storage: HiCodeStorageLayout, path: string): Promise<boolean> {
    path = resolve(path);
    if (isRecordPath(storage.projectsRoot, path)) return true;
    let probe = path;
    const missing: string[] = [];
    for (;;) {
        try {
            const canonical = resolve(await realpath(probe), ...missing);
            if (!recordPattern.test(canonical)) return false;
            const canonicalRoot = await realpath(storage.projectsRoot).catch(error => {
                if (hasFileSystemErrorCode(error, "ENOENT")) return null;
                throw error;
            });
            if (canonicalRoot && isRecordPath(canonicalRoot, canonical)) {
                throw new Error("Subagent records cannot be accessed through path aliases; use the provided record path");
            }
            return false;
        } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
            const parent = dirname(probe);
            if (parent === probe || missing.length >= 256) throw new Error("Cannot validate subagent record path");
            missing.unshift(basename(probe));
            probe = parent;
        }
    }
}

/** Internal session data is not part of delegated ordinary filesystem access. */
export async function isPrivateSessionPath(storage: HiCodeStorageLayout, path: string): Promise<boolean> {
    const root = storage.projectsRoot;
    return isPathInside(root, resolve(path)) || isPathInside(
        resolve(await resolveFilePermissionPath(root, storage.hicodeHome), relative(storage.hicodeHome, root)),
        await resolveFilePermissionPath(root, path));
}
