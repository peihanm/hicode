import {expect, test} from "bun:test";
import {writeFile, readFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeTool} from "../helpers/executeTool.js";

test.each(["\n", "\r\n"])("局部读取后连续修改保留未改区间并映射长度变化 %j", async lineEnding => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "file.txt"), ["first中文", "second😀", "UNREAD", ""].join(lineEnding));
        const ctx = createTestContext(cwd);
        await executeTool("read_file", JSON.stringify({path: "file.txt", limit: 2}), ctx);
        expect(await executeTool("edit_file", JSON.stringify({path: "file.txt", old_string: "first中文", new_string: "longer中文\nnew line"}), ctx)).toContain("已修改");
        expect(await executeTool("edit_file", JSON.stringify({path: "file.txt", old_string: "second😀", new_string: "changed😀"}), ctx)).toContain("已修改");
        expect(await executeTool("edit_file", JSON.stringify({path: "file.txt", old_string: "UNREAD", new_string: "blind"}), ctx)).toContain("未展示");
        expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(["longer中文", "new line", "changed😀", "UNREAD", ""].join(lineEnding));
    });
});

test("2100 行分两页完整读取才可整体替换", async () => {
    await withTempProject(async cwd => {
        const content = Array.from({length: 2100}, (_, n) => `line ${n}`).join("\n");
        await writeFile(join(cwd, "file.txt"), content);
        const ctx = createTestContext(cwd);
        await executeTool("read_file", JSON.stringify({path: "file.txt"}), ctx);
        expect(await executeTool("write_file", JSON.stringify({path: "file.txt", content: "blind"}), ctx)).toContain("完整 read_file");
        await executeTool("read_file", JSON.stringify({path: "file.txt", offset: 2001}), ctx);
        expect(await executeTool("write_file", JSON.stringify({path: "file.txt", content: "known"}), ctx)).toContain("已写入");
        expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("known");
    });
});
