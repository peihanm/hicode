import {expect, test} from "bun:test";
import {mkdir, readFile, writeFile, symlink} from "node:fs/promises";
import {join} from "node:path";
import {saveLocalNetworkMode} from "../../src/settings/permissionUpdate.js";
import {hicodeHostSettingsSchema, hicodeSettingsFileSchema} from "../../src/settings/schema.js";
import {withTempProject} from "../helpers/tempProject.js";

test("network mode persists locally, preserves other settings and rejects corrupt/symlink files", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, ".hicode"));
        const path = join(cwd, ".hicode/settings.local.json");
        await writeFile(path, JSON.stringify({permissions: {allow: ["read_file"]}, sandbox: {network: {allowedDomains: ["example.com"]}}}));
        await saveLocalNetworkMode(cwd, "open");
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({permissions: {allow: ["read_file"]}, sandbox: {network: {allowedDomains: ["example.com"], mode: "open"}}});
        await saveLocalNetworkMode(cwd, "restricted");
        expect(JSON.parse(await readFile(path, "utf8")).sandbox.network.mode).toBe("restricted");
        await writeFile(path, "broken-json");
        await expect(saveLocalNetworkMode(cwd, "open")).rejects.toThrow("corrupt");
        expect(await readFile(path, "utf8")).toBe("broken-json");
        const other = join(cwd, "other"); await mkdir(other);
        await symlink(join(cwd, ".hicode"), join(other, ".hicode"));
        await expect(saveLocalNetworkMode(other, "open")).rejects.toThrow("unsafe");
    });
});

test("file and Host schemas accept explicit policies and reject typos", () => {
    for (const schema of [hicodeSettingsFileSchema, hicodeHostSettingsSchema]) {
        expect(schema.safeParse({sandbox: {network: {mode: "open"}}}).success).toBe(true);
        expect(schema.safeParse({sandbox: {network: {mode: "anything"}}}).success).toBe(false);
    }
});
