import {readFile} from "node:fs/promises";
import {hasFileSystemErrorCode, withFileLock, writeFileAtomically,} from "../persistence/index.js";
import {getSettingsPath} from "./document.js";
import {pillarSettingsFileSchema} from "./schema.js";
import type {PillarSettingsFile} from "./types.js";

async function readSettingsForUpdate(path: string): Promise<PillarSettingsFile> {
    let content: string;
    try {
        content = await readFile(path, "utf8");
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return {};
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
    await withFileLock(`${path}.lock`, async () => {
        const settings = await readSettingsForUpdate(path);
        const permissions = settings.permissions ?? {};
        const allow = permissions.allow ?? [];
        if (allow.includes(rule)) return;

        settings.permissions = {
            ...permissions,
            allow: [...allow, rule],
        };
        await writeFileAtomically(path, `${JSON.stringify(settings, null, 2)}\n`);
    });
}
