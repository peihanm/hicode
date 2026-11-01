import {updateSettings} from "./store.js";

export async function appendLocalPermissionAllowRule(cwd: string, rule: string): Promise<void> {
    await updateSettings({source: "local", cwd}, settings => {
        const permissions = settings.permissions ??= {};
        const allow = permissions.allow ??= [];
        if (!allow.includes(rule)) allow.push(rule);
    });
}

export async function appendLocalPermissionDirectory(cwd: string, directory: string): Promise<void> {
    await updateSettings({source: "local", cwd}, settings => {
        const permissions = settings.permissions ??= {};
        const directories = permissions.additionalDirectories ??= [];
        if (!directories.includes(directory)) directories.push(directory);
    });
}

/** Only an explicit local UI action calls this; running Roots retain their startup policy. */
export async function saveLocalNetworkMode(cwd: string, mode: "restricted" | "open"): Promise<void> {
    await updateSettings({source: "local", cwd}, settings => {
        settings.sandbox = {...settings.sandbox, network: {...settings.sandbox?.network, mode}};
    });
}
