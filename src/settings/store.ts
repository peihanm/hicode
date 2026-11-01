import {lstat, mkdir, realpath} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {ensurePrivateStorageDirectory, hasFileSystemErrorCode, withFileLock, writeFileAtomically, type HiCodeStorageLayout} from "../persistence/index.js";
import {getUserSettingsPath} from "../persistence/layout.js";
import {readBoundedTextFile} from "../persistence/readTextFile.js";
import {hicodeSettingsFileSchema} from "./schema.js";
import {resolveModelSources} from "./resolve.js";
import type {HiCodeSettingsFile} from "./types.js";

export const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

type SettingsTarget =
    | {source: "user"; storage: HiCodeStorageLayout}
    | {source: "project" | "local"; cwd: string};

export function getSettingsPath(target: SettingsTarget): string {
    return target.source === "user" ? getUserSettingsPath(target.storage)
        : resolve(target.cwd, ".hicode", target.source === "project" ? "settings.json" : "settings.local.json");
}

async function ensureParent(target: SettingsTarget, create: boolean): Promise<void> {
    const directory = dirname(getSettingsPath(target));
    if (create) {
        if (target.source === "user") ensurePrivateStorageDirectory(target.storage, directory);
        else await mkdir(directory, {recursive: true, mode: 0o700});
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Cannot access settings through an unsafe .hicode directory");
    if (target.source !== "user" && await realpath(directory) !== join(await realpath(target.cwd), ".hicode")) {
        throw new Error("Cannot access settings through an unsafe .hicode directory");
    }
}

async function readText(target: SettingsTarget): Promise<string> {
    try {
        await ensureParent(target, false);
        return readBoundedTextFile(getSettingsPath(target), MAX_SETTINGS_BYTES);
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return "";
        throw error;
    }
}

function decode(text: string): HiCodeSettingsFile {
    try {return hicodeSettingsFileSchema.parse(text.trim() ? JSON.parse(text) : {});}
    catch {throw new Error("Invalid settings file; existing contents were not overwritten");}
}

export async function readSettings(target: SettingsTarget): Promise<HiCodeSettingsFile> {
    return decode(await readText(target));
}

/** Shared JSON transaction. Credential files have their own writer and never enter this path. */
export async function updateSettings(
    target: SettingsTarget,
    modify: (settings: HiCodeSettingsFile) => void | Promise<void>
): Promise<HiCodeSettingsFile> {
    const path = getSettingsPath(target);
    await ensureParent(target, true);
    return withFileLock(`${path}.lock`, async () => {
        const before = await readText(target);
        const settings = decode(before);
        const previous = JSON.stringify(settings);
        await modify(settings);
        const normalized = decode(JSON.stringify(settings));
        if (target.source === "user" && normalized.sources) {
            resolveModelSources([{source: "user", path, value: {sources: normalized.sources}}]);
        }
        const content = `${JSON.stringify(normalized, null, 2)}\n`;
        if (Buffer.byteLength(content) > MAX_SETTINGS_BYTES) throw new Error("Configuration exceeds 4 MiB");
        if (await readText(target) !== before) throw new Error("Configuration changed while saving; retry after reviewing it");
        if (JSON.stringify(normalized) !== previous) await writeFileAtomically(path, content, 0o600);
        return normalized;
    });
}
