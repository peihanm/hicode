import {createHash} from "node:crypto";
import {realpathSync} from "node:fs";
import {basename, resolve} from "node:path";

function hash(value: string, length: number): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function canonicalizeProjectPath(cwd: string): string {
    try {
        return realpathSync.native(cwd).normalize("NFC");
    } catch {
        return resolve(cwd).normalize("NFC");
    }
}

export function getProjectKey(cwd: string): string {
    const canonical = canonicalizeProjectPath(cwd);
    const safeName =
        basename(canonical).replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
    return `${safeName}-${hash(canonical, 16)}`;
}

export function hashProjectValue(value: string, length: number): string {
    return hash(value, length);
}
