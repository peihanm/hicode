import {lstat, mkdir, readFile, realpath} from "node:fs/promises";
import {dirname, join} from "node:path";
import {hasFileSystemErrorCode, withFileLock, writeFileAtomically,} from "../persistence/index.js";
import {getSettingsPath} from "./document.js";
import {pillarSettingsFileSchema} from "./schema.js";
import type {PillarSettingsFile} from "./types.js";

const MAX_LOCAL_SETTINGS_BYTES = 4 * 1024 * 1024;

function isMissing(error: unknown): boolean {
    return hasFileSystemErrorCode(error, "ENOENT");
}

async function ensureSafeLocalSettingsPath(
    cwd: string,
    path: string
): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const [cwdPath, directoryPath, directoryInfo] = await Promise.all([
        realpath(cwd),
        realpath(directory),
        lstat(directory),
    ]);
    if (
        directoryInfo.isSymbolicLink() ||
        !directoryInfo.isDirectory() ||
        directoryPath !== join(cwdPath, ".pillar")
    ) {
        throw new Error("Cannot update settings through an unsafe .pillar directory");
    }
    try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error("Cannot update settings through a non-regular file");
        }
        if (info.size > MAX_LOCAL_SETTINGS_BYTES) {
            throw new Error("Cannot update settings larger than 4 MiB");
        }
    } catch (error) {
        if (!isMissing(error)) throw error;
    }
}

async function readSettingsForUpdate(path: string): Promise<PillarSettingsFile> {
    let content: string;
    try {
        content = await readFile(path, "utf8");
    } catch (error) {
        if (isMissing(error)) return {};
        throw error;
    }

    let raw: unknown;
    try {
        raw = content.trim() ? JSON.parse(content) : {};
    } catch (error) {
        throw new Error(`Cannot update corrupt settings: ${path}`, {cause: error});
    }

    const parsed = pillarSettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`Cannot update invalid settings: ${path}`, {
            cause: parsed.error,
        });
    }
    return parsed.data;
}

export async function appendLocalPermissionAllowRule(
    cwd: string,
    rule: string
): Promise<void> {
    const path = getSettingsPath(cwd, "local");
    await ensureSafeLocalSettingsPath(cwd, path);
    await withFileLock(`${path}.lock`, async () => {
        await ensureSafeLocalSettingsPath(cwd, path);
        const settings = await readSettingsForUpdate(path);
        const permissions = settings.permissions ?? {};
        const allow = permissions.allow ?? [];
        if (allow.includes(rule)) return;

        settings.permissions = {
            ...permissions,
            allow: [...allow, rule],
        };
        const content = `${JSON.stringify(settings, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_LOCAL_SETTINGS_BYTES) {
            throw new Error("Cannot update settings larger than 4 MiB");
        }
        await writeFileAtomically(path, content, 0o600);
    });
}

export async function appendLocalPermissionDirectory(
    cwd: string,
    directory: string
): Promise<void> {
    const path = getSettingsPath(cwd, "local");
    await ensureSafeLocalSettingsPath(cwd, path);
    await withFileLock(`${path}.lock`, async () => {
        await ensureSafeLocalSettingsPath(cwd, path);
        const settings = await readSettingsForUpdate(path);
        const permissions = settings.permissions ?? {};
        const additionalDirectories =
            permissions.additionalDirectories ?? [];
        if (additionalDirectories.includes(directory)) return;

        settings.permissions = {
            ...permissions,
            additionalDirectories: [...additionalDirectories, directory],
        };
        const content = `${JSON.stringify(settings, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_LOCAL_SETTINGS_BYTES) {
            throw new Error("Cannot update settings larger than 4 MiB");
        }
        await writeFileAtomically(path, content, 0o600);
    });
}
