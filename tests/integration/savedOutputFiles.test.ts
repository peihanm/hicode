import {contentText} from "../../src/images/content.js";
import {expect, test} from "bun:test";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createToolCatalog} from "../../src/tools/catalog.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

test("结果文件通过普通 Read 行分页，独立结果工具不再注册", async () => {
    expect(createToolCatalog({}).tools.map(tool => tool.name)).not.toContain("read_tool_result");
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const saved = await ctx.toolResultStore.persistText({toolCallId: "lines", toolName: "test", content: "一😀\n二\n三"});
        const first = await executeToolResult("read_file", JSON.stringify({path: saved.path, offset: 2, limit: 1}), ctx, "first");
        expect(first.outcome).toBe("ok");
        expect(first.modelContent).toContain("2\t二");
        expect(first.modelContent).toContain("offset=3");
        expect(first.modelContent).not.toContain("一😀");
        const last = await executeToolResult("read_file", JSON.stringify({path: saved.path, offset: 3}), ctx, "last");
        expect(last.modelContent).toContain("3\t三");
        expect(last.modelContent).not.toContain("继续读取");
    });
});

test("超过普通 Read 大小上限的结果仍可按行读尾部，长行明确省略且输出有界", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const content = `${("你😀".repeat(300) + "\n").repeat(3000)}END`;
        const saved = await ctx.toolResultStore.persistText({toolCallId: "big", toolName: "test", content});
        expect(saved.byteLength).toBeGreaterThan(5 * 1024 * 1024);
        const result = await executeToolResult("read_file", JSON.stringify({path: saved.path, offset: 3001}), ctx, "tail");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("3001\tEND");
        const long = await ctx.toolResultStore.persistText({toolCallId: "long-line", toolName: "test", content: `START${"😀".repeat(200_000)}END\nNEXT`});
        const read = await executeToolResult("read_file", JSON.stringify({path: long.path, limit: 1}), ctx, "long");
        expect(read.modelContent.length).toBeLessThan(64_000);
        expect(read.modelContent).toContain("START");
        expect(read.modelContent).toContain("END");
        expect(read.modelContent).toContain("[middle omitted]");
        expect(read.modelContent).toContain("not shown in full");
        expect(read.modelContent).toContain("offset=2");
        expect(Buffer.from(contentText(read.modelContent)).toString("utf8")).toBe(contentText(read.modelContent));
    });
});

test("只读结果路径例外不放开目录、不绕过规则或伪造 metadata", async () => {
    await withTempProject(async cwd => {
        const boundary = join(cwd, "worktree");
        await mkdir(boundary);
        const ctx = createTestContext(cwd, {workspaceBoundary: boundary});
        const saved = await ctx.toolResultStore.persistText({toolCallId: "owned", toolName: "test", content: "ERR_ASSERTION\ncontext"});
        for (const tool of ["read_file", "bash"]) {
            const args = JSON.stringify(tool === "bash" ? {command: `rg -n -e ERR_ASSERTION '${saved.path}'`} : {path: saved.path});
            expect((await executeToolResult(tool, args, ctx, tool)).outcome).toBe("ok");
            ctx.permissionRules.deny.push({toolName: tool, source: "project"});
            expect((await executeToolResult(tool, args, ctx, `denied-${tool}`)).outcome).toBe("denied");
            ctx.permissionRules.deny = [];
        }
        expect((await executeToolResult("bash", JSON.stringify({command: `rg -e . '${ctx.toolResultStore.sessionDir}'`}), ctx, "directory")).outcome).toBe("denied");
        const other = createTestToolResultStore(cwd, "other");
        const foreign = await other.persistText({toolCallId: "foreign", toolName: "test", content: "private"});
        expect((await executeToolResult("read_file", JSON.stringify({path: foreign.path}), ctx, "foreign")).outcome).toBe("denied");
        const metadata = saved.path.slice(0, -4) + ".meta.json";
        const raw: unknown = JSON.parse(await readFile(metadata, "utf8"));
        expect(typeof raw).toBe("object");
        await writeFile(metadata, JSON.stringify({...raw as Record<string, unknown>, resultId: "forged"}));
        expect((await executeToolResult("read_file", JSON.stringify({path: saved.path}), ctx, "forged")).outcome).toBe("denied");
    });
});
