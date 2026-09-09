import {expect, test} from "bun:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {contentText} from "../../src/images/content.js";

test("危险行/跨行正则可取消，主线程继续响应，下一调用可正常执行", async () => {
    // An outer process deadline catches a regression that blocks even the test runner's timer.
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../fixtures/grepCancellation.ts", import.meta.url))],
        {timeout: 4_000, env: {PATH: process.env.PATH}});
    expect(result.stdout).toBe("GREP_CANCELLED_AND_RECOVERED");
});

test("非法正则为 failed；中文、反向引用和前后向断言保持 JS 语义", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "source.txt"), "前文\r\n中文 AbAb tail\r\n后文");
        const ctx = createTestContext(cwd);
        const invalid = await executeToolResult("grep", '{"path":"source.txt","pattern":"["}', ctx, "invalid");
        expect(invalid.outcome).toBe("failed");
        for (const pattern of ["(?<=中文 )([a-z]{2})\\1(?= tail)", "前文\\r?\\n中文"]) {
            const found = await executeToolResult("grep", JSON.stringify({path: "source.txt", pattern, ignore_case: true, multiline: pattern.startsWith("前"), context: 1}), ctx, pattern);
            expect(found.outcome).toBe("ok");
            expect(found.modelContent).toContain("中文 AbAb tail");
            expect(found.modelContent).toContain("前文");
        }
    });
});

test("没有用户取消时，危险正则仍有执行期限且不伪报零匹配", async () => {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../fixtures/grepCancellation.ts", import.meta.url)), "deadline"],
        {timeout: 8_000, env: {PATH: process.env.PATH}});
    expect(result.stdout).toBe("GREP_FAILED_WITHOUT_FALSE_NEGATIVE");
}, 10_000);

test("1.2 MiB 单行中部命中与 10 MiB 多行日志可通过原结果路径搜索", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const long = await ctx.toolResultStore.persistText({toolCallId: "long", toolName: "bash",
            content: "😀".repeat(150_000) + "NEEDLE_MIDDLE" + "你".repeat(200_000)});
        expect(long.complete).toBe(true);
        expect(long.preview).not.toContain("NEEDLE_MIDDLE");
        const result = await executeToolResult("grep", JSON.stringify({path: long.path, pattern: "NEEDLE_MIDDLE", head_limit: 20}), ctx, "long-search");
        expect(result.outcome).toBe("ok");
        const text = contentText(result.modelContent);
        expect(text).toContain("NEEDLE_MIDDLE");
        expect(text).toContain("UTF-16 列");
        expect(text.length).toBeLessThan(4_000);
        expect(Buffer.from(text).toString("utf8")).toBe(text);
        const lines = ("ordinary output".padEnd(1023, "x") + "\n").repeat(5120);
        const saved = await ctx.toolResultStore.persistText({toolCallId: "many", toolName: "bash", content: lines + "before\nERR_ASSERTION at game.test.js:42\nafter\n" + lines});
        expect(saved.byteLength).toBeGreaterThan(10 * 1024 * 1024);
        const found = await executeToolResult("grep", JSON.stringify({path: saved.path, pattern: "ERR_ASSERTION", context: 1}), ctx, "many-search");
        expect(found.outcome).toBe("ok");
        expect(found.modelContent).toContain(":5122");
        expect(found.modelContent).toContain("game.test.js:42");
        expect(found.modelContent).toContain("before");
        expect(found.modelContent).toContain("after");
        const foreign = await executeToolResult("grep", JSON.stringify({path: saved.path, pattern: "ERR_ASSERTION"}), createTestContext(cwd, {sessionId: "other"}), "foreign");
        expect(foreign.outcome).toBe("failed");
        expect(foreign.modelContent).not.toContain("game.test.js:42");
    });
});
