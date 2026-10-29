import {expect, test} from "bun:test";
import {readFile, realpath, writeFile} from "node:fs/promises";
import {ensureProjectIdentity} from "../../src/persistence/storageIdentity.js";
import {getProjectIdentityPath} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";

test("concurrent project initialization preserves an existing identity", async () => {
    await withTempProject(async (cwd, storage) => {
        await Promise.all(Array.from({length: 4}, () => ensureProjectIdentity(storage, cwd)));
        const path = getProjectIdentityPath(storage, cwd);
        const original = await readFile(path, "utf8");
        expect(JSON.parse(original).cwd).toBe(await realpath(cwd));
        await ensureProjectIdentity(storage, cwd);
        expect(await readFile(path, "utf8")).toBe(original);
    });
});

test("project initialization rejects mismatched or corrupt identity without replacing it", async () => {
    await withTempProject(async (cwd, storage) => {
        await ensureProjectIdentity(storage, cwd);
        const path = getProjectIdentityPath(storage, cwd);
        const original = JSON.parse(await readFile(path, "utf8"));
        for (const content of [JSON.stringify({...original, cwd: "/different-project"}), "broken identity"]) {
            await writeFile(path, content);
            await expect(ensureProjectIdentity(storage, cwd)).rejects.toThrow();
            expect(await readFile(path, "utf8")).toBe(content);
        }
    });
});
