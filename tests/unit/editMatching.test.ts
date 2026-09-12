import {expect, test} from "bun:test";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeTool} from "../helpers/executeTool.js";

test.each([
    {content: '"hello"\n“hello”\n', all: false, expected: 'updated\n“hello”\n', count: 1},
    {content: '"hello"\n“hello”\n', all: true, expected: 'updated\n“hello”\n', count: 1},
    {content: '“hello”\n”hello“\n', all: true, expected: 'updated\nupdated\n', count: 2},
])("Edit 匹配、替换与数量同源 %j", async item => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "text.txt"), item.content);
        const ctx = createTestContext(cwd);
        await executeTool("read_file", JSON.stringify({path: "text.txt"}), ctx);
        const result = await executeTool("edit_file", JSON.stringify({
            path: "text.txt", edits: [{old_string: '"hello"', new_string: "updated", replace_all: item.all}],
        }), ctx);
        expect(result).toContain(`replaced ${item.count} matches`);
        expect(await readFile(join(cwd, "text.txt"), "utf8")).toBe(item.expected);
    });
});
