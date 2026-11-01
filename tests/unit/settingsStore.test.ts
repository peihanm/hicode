import {expect, test} from "bun:test";
import {mkdir, readFile, stat, symlink, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {getSettingsPath, readSettings, updateSettings, MAX_SETTINGS_BYTES} from "../../src/settings/store.js";
import {appendLocalPermissionAllowRule, appendLocalPermissionDirectory, saveLocalNetworkMode} from "../../src/settings/permissionUpdate.js";
import {withTempProject} from "../helpers/tempProject.js";

test("shared settings transactions preserve concurrent model, permission and network updates", async () => {
    await withTempProject(async cwd => {
        const target = {source: "local", cwd} as const;
        const path = getSettingsPath(target);
        await mkdir(join(cwd, ".hicode"));
        await writeFile(path, JSON.stringify({custom: {keep: true}, permissions: {deny: ["write_file"]}}));
        await Promise.all([
            updateSettings(target, settings => {settings.models = {primary: {source: "qwen", model: "qwen3.8-flash"}};}),
            appendLocalPermissionAllowRule(cwd, "bash(git status:*)"),
            appendLocalPermissionDirectory(cwd, "/shared/project"),
            saveLocalNetworkMode(cwd, "restricted"),
        ]);
        expect<unknown>(await readSettings(target)).toEqual({
            custom: {keep: true}, models: {primary: {source: "qwen", model: "qwen3.8-flash"}},
            permissions: {deny: ["write_file"], allow: ["bash(git status:*)"], additionalDirectories: ["/shared/project"]},
            sandbox: {network: {mode: "restricted"}},
        });
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        const before = await readFile(path, "utf8"), identity = await stat(path);
        await appendLocalPermissionAllowRule(cwd, "bash(git status:*)");
        await appendLocalPermissionDirectory(cwd, "/shared/project");
        await saveLocalNetworkMode(cwd, "restricted");
        expect(await readFile(path, "utf8")).toBe(before);
        expect((await stat(path)).ino).toBe(identity.ino);
    });
});

test("shared writer refuses malformed, invalid UTF-8 and oversized input before mutation", async () => {
    await withTempProject(async cwd => {
        const target = {source: "local", cwd} as const;
        await mkdir(join(cwd, ".hicode"));
        const path = getSettingsPath(target);
        for (const input of [Buffer.from("{broken"), Buffer.from('{"permissions":{"allow":true}}'),
            Buffer.from([0xff]), Buffer.alloc(MAX_SETTINGS_BYTES + 1, 32)]) {
            await writeFile(path, input);
            let mutated = false;
            await expect(updateSettings(target, () => {mutated = true;})).rejects.toThrow();
            await expect(readSettings(target)).rejects.toThrow();
            expect(mutated).toBe(false);
            expect((await readFile(path)).equals(input)).toBe(true);
        }
    });
});

test("shared writer rejects settings symlinks and dangling directory links", async () => {
    await withTempProject(async cwd => {
        const target = {source: "local", cwd} as const;
        const outside = join(cwd, "outside.json");
        await writeFile(outside, '{"memory":{"enabled":false}}');
        await mkdir(join(cwd, ".hicode"));
        await symlink(outside, getSettingsPath(target));
        await expect(appendLocalPermissionAllowRule(cwd, "read_file")).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe('{"memory":{"enabled":false}}');
        await unlink(getSettingsPath(target));
        await symlink(join(cwd, "missing.json"), getSettingsPath(target));
        await expect(appendLocalPermissionAllowRule(cwd, "read_file")).rejects.toThrow();
        const child = join(cwd, "child"); await mkdir(child);
        await symlink(join(cwd, "missing-directory"), join(child, ".hicode"));
        await expect(readSettings({source: "local", cwd: child})).rejects.toThrow("unsafe");
    });
});

test("shared writer validates changed fields and never overwrites a concurrent external edit", async () => {
    await withTempProject(async cwd => {
        const target = {source: "local", cwd} as const;
        const path = getSettingsPath(target);
        await mkdir(join(cwd, ".hicode"));
        await writeFile(path, '{"memory":{"enabled":false}}');
        await expect(appendLocalPermissionAllowRule(cwd, "read_file(~/.ssh)")).rejects.toThrow("Invalid settings file");
        expect(await readFile(path, "utf8")).toBe('{"memory":{"enabled":false}}');
        const external = '{"memory":{"enabled":false},"custom":"external change"}';
        await expect(updateSettings(target, async settings => {
            settings.memory = {enabled: true};
            await writeFile(path, external);
        })).rejects.toThrow("changed while saving");
        expect(await readFile(path, "utf8")).toBe(external);
    });
});
