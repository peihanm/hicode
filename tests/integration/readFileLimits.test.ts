import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {contentText} from "../../src/images/content.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";

test.each(["source", "saved"] as const)("%s 按行数和字符上限分页，无漏行、重复或字符损坏", async kind => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        for (const wide of [false, true]) {
            const expected = Array.from({length: wide ? 800 : 2100}, (_, index) =>
                `${index}: ${wide ? "中文😀".repeat(60) : "short"}`);
            expected.push("");
            const content = expected.join("\n");
            const source = join(cwd, `${wide}.txt`);
            await writeFile(source, content);
            const path = kind === "source" ? source : (await ctx.toolResultStore.persistText({
                toolCallId: `saved-${wide}`, toolName: "fixture", content,
            })).path;
            const observed: string[] = [];
            let offset = 1;
            for (let page = 0; page < 10; page++) {
                const result = await executeToolResult("read_file", JSON.stringify({path, offset}), ctx, `${kind}-${wide}-${page}`);
                expect(result.outcome).toBe("ok");
                expect(result.persisted).toBeUndefined();
                const text = contentText(result.modelContent);
                expect(text.length).toBeLessThanOrEqual(60_000);
                const rows = [...text.matchAll(/^ *(\d+)\t([^\n]*)$/gm)];
                expect(rows.length).toBeGreaterThan(0);
                expect(rows.length).toBeLessThanOrEqual(2000);
                if (page === 0 && !wide) expect(rows.length).toBe(2000);
                if (wide) expect(rows.length).toBeLessThan(2000);
                if (wide) expect(text).not.toContain("\uFFFD");
                for (const row of rows) {
                    expect(Number(row[1])).toBe(observed.length + 1);
                    observed.push(row[2]!);
                }
                const next = text.match(/Continue with read_file on the same path, offset=(\d+)/);
                if (!next) break;
                if (wide) expect(text).toContain("Character limit reached");
                offset = Number(next[1]);
                expect(offset).toBe(observed.length + 1);
                if (kind === "source") expect(ctx.fileState.check(source, content, {requireFullRead: true}).ok).toBe(false);
            }
            expect(observed).toEqual(expected);
            if (kind === "source") expect(ctx.fileState.check(source, content, {requireFullRead: true})).toEqual({ok: true});
            else expect(ctx.fileState.check(source, content).ok).toBe(false);
        }
    });
});

test.each(["source", "saved"] as const)("%s 区分本页放不下和单行过长；不把未展示正文计为已读", async kind => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const content = `${"a".repeat(30_000)}\n${"b".repeat(30_000)}\n${"界😀".repeat(30_000)}\nTAIL`;
        const source = join(cwd, "long.txt");
        await writeFile(source, content);
        const path = kind === "source" ? source : (await ctx.toolResultStore.persistText({
            toolCallId: "saved-long", toolName: "fixture", content,
        })).path;
        const read = async (offset: number) => contentText((await executeToolResult("read_file",
            JSON.stringify({path, offset}), ctx, `long-${offset}`)).modelContent);
        const first = await read(1);
        expect(first).toContain("Character limit reached");
        expect(first).toContain("offset=2");
        expect(first).not.toContain("b".repeat(100));
        const second = await read(2);
        expect(second).toContain("b".repeat(30_000));
        expect(second).toContain("Line 3 exceeds");
        expect(second).not.toContain("界😀");
        expect(second).not.toContain("TAIL");
        expect(second).toContain("offset=4");
        const hugeOnly = await read(3);
        expect(hugeOnly).toContain("Line range: none");
        expect(hugeOnly).not.toContain("outside");
        expect(await read(4)).toContain("4\tTAIL");
        for (const text of [first, second, hugeOnly]) expect(text.length).toBeLessThanOrEqual(60_000);
        const write = await executeToolResult("write_file", JSON.stringify({path: source, content: "blind"}), ctx, "blind");
        expect(write.outcome).toBe("failed");
        expect(write.modelContent).toContain("Write precondition failed");
    });
});

test.each(["", "one", "one\n", "一😀\n二\n"])("读取 EOF 和末尾空行：%j", async content => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const source = join(cwd, "eof.txt");
        await writeFile(source, content);
        const saved = await ctx.toolResultStore.persistText({toolCallId: "eof", toolName: "fixture", content});
        for (const path of [source, saved.path]) {
            const lines = content.split("\n");
            for (let offset = 1; offset <= lines.length; offset++) {
                const result = await executeToolResult("read_file", JSON.stringify({path, offset, limit: 1}), ctx, `${path}-${offset}`);
                const text = contentText(result.modelContent);
                expect(text).toContain(`${offset}\t${lines[offset - 1]}`);
                expect(text.includes("Continue with")).toBe(offset < lines.length);
            }
            const past = await executeToolResult("read_file", JSON.stringify({path, offset: lines.length + 1}), ctx, `past-${path}`);
            expect(past.modelContent).toMatch(/out of range|outside/);
        }
    });
});
