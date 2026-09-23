import {expect, test} from "bun:test";
import {writeFile, symlink, mkdir} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {readBoundedTextFile} from "../../src/persistence/readTextFile.js";
import {readPrivateStorageTextFile} from "../../src/persistence/privateStorage.js";

test("bounded text reads reject oversized, invalid UTF-8 and redirected files", async () => {
    await withTempProject(async (cwd, storage) => {
        const file = join(cwd, "file.txt");
        await writeFile(file, "中文");
        expect(readBoundedTextFile(file, 6)).toBe("中文");
        expect(() => readBoundedTextFile(file, 5)).toThrow("size limit");
        await writeFile(file, Buffer.from([0xff]));
        expect(() => readBoundedTextFile(file, 6)).toThrow();
        await writeFile(file, "");
        expect(readBoundedTextFile(file, 0)).toBe("");
        await symlink(file, join(cwd, "alias"));
        expect(() => readBoundedTextFile(join(cwd, "alias"), 6)).toThrow();
        expect(() => readBoundedTextFile(cwd, 6)).toThrow("regular file");
        await mkdir(storage.hicodeHome, {recursive: true});
        await writeFile(join(storage.hicodeHome, "bad.json"), Buffer.from([123,34,97,34,58,34,255,34,125]));
        expect(() => readPrivateStorageTextFile(storage, join(storage.hicodeHome, "bad.json"), 100)).toThrow();
        expect(readPrivateStorageTextFile(storage, join(storage.hicodeHome, "absent"), 100)).toBeNull();
    });
});
