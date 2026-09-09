import {expect, test} from "bun:test";
import {access, chmod, lstat, rename, truncate, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";

test.each(["image.png", "font.woff2", "large.txt"])("目标确认后删除资产 %s", async name => {
    await withTempProject(async cwd => {
        const content = name === "large.txt" ? Buffer.alloc(6 * 1024 * 1024, 120) : Buffer.from([137, 80, 78, 71, 0, 255, 254, 128]);
        const path = join(cwd, name);
        await writeFile(path, content);
        await chmod(path, 0o640);
        const ctx = createTestContext(cwd);
        const observation = await executeToolResult("read_file", JSON.stringify({path: name}), ctx, "observe");
        expect(observation.modelContent).toContain("SHA256");
        const edit = await executeToolResult("write_file", JSON.stringify({path: name, content: "blind"}), ctx, "overwrite");
        expect(edit.outcome).toBe("failed");
        const deleted = await executeToolResult("delete_file", JSON.stringify({path: name}), ctx, "delete");
        expect(deleted.outcome).toBe("ok");
        expect(deleted.uiData).toMatchObject({type: "file_change", change: {kind: "delete"}});
        expect(await access(path).then(() => true, () => false)).toBe(false);
    });
});

test("工具刚创建的文件可删除，同内容换 inode 后必须重新确认", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        for (const swapped of [false, true]) {
            const path = join(cwd, `created-${swapped}.txt`);
            expect((await executeToolResult("write_file", JSON.stringify({path, content: "created"}), ctx, `write-${swapped}`)).outcome).toBe("ok");
            if (swapped) {
                await writeFile(join(cwd, "replacement"), "created");
                await rename(join(cwd, "replacement"), path);
            }
            expect((await executeToolResult("delete_file", JSON.stringify({path}), ctx, `delete-${swapped}`)).outcome).toBe(swapped ? "denied" : "ok");
        }
    });
});

test("超过 安全读取上限的文件不授予读取或删除凭据", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "oversized.bin");
        await writeFile(path, "");
        await truncate(path, 20 * 1024 * 1024 + 1);
        const ctx = createTestContext(cwd);
        expect((await executeToolResult("read_file", JSON.stringify({path}), ctx, "read")).outcome).toBe("failed");
        expect((await executeToolResult("delete_file", JSON.stringify({path}), ctx, "delete")).outcome).toBe("denied");
        expect((await lstat(path)).size).toBe(20 * 1024 * 1024 + 1);
    });
});

test("资产同内容换 inode 必须重新确认", async () => {
    await withTempProject(async cwd => {
        const content = Buffer.from([0, 255, 1]);
        const path = join(cwd, "asset.png");
        await writeFile(path, content);
        const ctx = createTestContext(cwd);
        await executeToolResult("read_file", JSON.stringify({path}), ctx, "observe");
        await writeFile(join(cwd, "replacement"), content);
        await rename(join(cwd, "replacement"), path);
        expect((await executeToolResult("delete_file", JSON.stringify({path}), ctx, "stale")).outcome).toBe("denied");
        await executeToolResult("read_file", JSON.stringify({path}), ctx, "reread");
        const result = await executeToolResult("delete_file", JSON.stringify({path}), ctx, "confirmed");
        expect(result.outcome).toBe("ok");
        expect(await access(path).then(() => true, () => false)).toBe(false);
    });
});
