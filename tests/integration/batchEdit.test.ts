import {describe, expect, test} from "bun:test";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createTestContext} from "../helpers/testContext.js";
import {executeTool, executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("单文件批量编辑", () => {
    test("乱序的多项替换在原版本定位，CRLF 和 Unicode 保留，一次完成修改", async () => {
        await withTempProject(async cwd => {
            const path = join(cwd, "file.txt");
            const original = "甲A\r\nB😀\r\nsame same\r\n";
            await writeFile(path, original);
            const ctx = createTestContext(cwd);
            await executeTool("read_file", JSON.stringify({path}), ctx);
            const result = await executeToolResult("edit_file", JSON.stringify({path, edits: [
                {old_string: "same", new_string: "同", replace_all: true},
                {old_string: "B😀", new_string: "C🙂"},
                {old_string: "甲A", new_string: "B😀"},
            ]}), ctx, "batch-edit");
            expect(result.outcome).toBe("ok");
            expect(await readFile(path, "utf8")).toBe("B😀\r\nC🙂\r\n同 同\r\n");
            expect(result.uiData).toMatchObject({type: "file_change", change: {replacements: 4}});
        });
    });

    test.each([
        {name: "后项缺失", edits: [{old_string: "alpha", new_string: "new"}, {old_string: "missing", new_string: "x"}], error: "Item 2"},
        {name: "后项歧义", edits: [{old_string: "alpha", new_string: "new"}, {old_string: "same", new_string: "x"}], error: "matched 2 locations"},
        {name: "后项引用前项输出", edits: [{old_string: "alpha", new_string: "generated"}, {old_string: "generated", new_string: "x"}], error: "was not found in the original version"},
        {name: "范围重叠", edits: [{old_string: "alpha", new_string: "new"}, {old_string: "pha", new_string: "x"}], error: "overlap"},
        {name: "重复项", edits: [{old_string: "alpha", new_string: "new"}, {old_string: "alpha", new_string: "x"}], error: "overlap"},
        {name: "replace_all 与其他项重叠", edits: [{old_string: "same", new_string: "x", replace_all: true}, {old_string: "same end", new_string: "y"}], error: "overlap"},
    ].map(({name, edits, error}) => [name, edits, error] as const))("%s：整次失败，没有文件变化", async (_name, edits, error) => {
        await withTempProject(async cwd => {
            const path = join(cwd, "file.txt");
            const original = "alpha same same end\n";
            await writeFile(path, original);
            const ctx = createTestContext(cwd);
            await executeTool("read_file", JSON.stringify({path}), ctx);
            const result = await executeToolResult("edit_file", JSON.stringify({path, edits}), ctx, "invalid-batch");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain(error);
            expect(result.modelContent).toContain("No file was written");
            expect(result.uiData).toBeUndefined();
            expect(await readFile(path, "utf8")).toBe(original);
        });
    });

    test("多段局部读取的观察范围在乱序、变长编辑后正确移动，隐藏文本仍不可写", async () => {
        await withTempProject(async cwd => {
            const path = join(cwd, "file.txt");
            await writeFile(path, "一A\nSECRET\n三B\nEND\n");
            const ctx = createTestContext(cwd);
            for (const offset of [1, 3]) {
                await executeTool("read_file", JSON.stringify({path, offset, limit: 1}), ctx);
            }
            expect(await executeTool("edit_file", JSON.stringify({path, edits: [
                {old_string: "三B", new_string: "三🙂加长"},
                {old_string: "一A", new_string: "首"},
            ]}), ctx)).toContain("replaced 2 matches");
            const hidden = await executeToolResult("edit_file", JSON.stringify({path, edits: [
                {old_string: "首", new_string: "changed"},
                {old_string: "SECRET", new_string: "hidden"},
            ]}), ctx, "hidden-batch");
            expect(hidden.outcome).toBe("failed");
            expect(hidden.modelContent).toContain("Item 2");
            expect(hidden.modelContent).toContain("did not show");
            const all = await executeToolResult("edit_file", JSON.stringify({path, edits: [
                {old_string: "首", new_string: "changed", replace_all: true},
            ]}), ctx, "full-read-required");
            expect(all.outcome).toBe("failed");
            expect(all.modelContent).toContain("replace_all requires reading the entire file");
            expect(await executeTool("edit_file", JSON.stringify({path, edits: [
                {old_string: "首", new_string: "头"},
                {old_string: "三🙂加长", new_string: "尾"},
            ]}), ctx)).toContain("replaced 2 matches");
            expect(await readFile(path, "utf8")).toBe("头\nSECRET\n尾\nEND\n");
        });
    });

    test("相邻范围可修改；全部无变化时不创建修改记录", async () => {
        await withTempProject(async cwd => {
            const path = join(cwd, "file.txt");
            const ctx = createTestContext(cwd);
            await writeFile(path, "AB");
            await executeTool("read_file", JSON.stringify({path}), ctx);
            const result = await executeToolResult("edit_file", JSON.stringify({path, edits: [
                {old_string: "B", new_string: "A"}, {old_string: "A", new_string: "B"},
            ]}), ctx, "adjacent");
            expect(result.outcome).toBe("ok");
            expect(await readFile(path, "utf8")).toBe("BA");
            const noop = await executeToolResult("edit_file", JSON.stringify({path, edits: [
                {old_string: "B", new_string: "B"}, {old_string: "A", new_string: "A"},
            ]}), ctx, "noop");
            expect(noop.outcome).toBe("ok");
            expect(noop.uiData).toBeUndefined();
            expect(noop.modelContent).toContain("No changes needed for");
        });
    });

    test("旧协议、空 edits 和未知字段在执行前拒绝", async () => {
        await withTempProject(async cwd => {
            const ctx = createTestContext(cwd);
            const path = join(cwd, "file.txt");
            await writeFile(path, "before");
            await executeTool("read_file", JSON.stringify({path}), ctx);
            for (const args of [
                {path, old_string: "before", new_string: "after"},
                {path, edits: []},
                {path, edits: [{old_string: "before", new_string: "after", extra: true}]},
                {path, edits: [{old_string: "before", new_string: "after"}], replace_all: true},
            ]) {
                const result = await executeToolResult("edit_file", JSON.stringify(args), ctx, "bad-schema");
                expect(result.outcome).not.toBe("ok");
                expect(result.uiData).toBeUndefined();
                expect(await readFile(path, "utf8")).toBe("before");
            }
        });
    });
});
