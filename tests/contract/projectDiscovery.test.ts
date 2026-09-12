import {contentText} from "../../src/images/content.js";
import {expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {executeToolResult} from "../helpers/executeTool.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

async function put(cwd: string, path: string, text = "DISCOVERY_TOKEN") {
    const file = join(cwd, path);
    await mkdir(join(file, ".."), {recursive: true});
    await writeFile(file, text);
}

test("glob/grep 共享 ignore 文件视图，保留 src/build 与嵌套反忽略源码", async () => {
    await withTempProject(async cwd => {
        await put(cwd, ".gitignore", "generated/\n*.tmp.ts\n");
        await put(cwd, "src/.gitignore", "!keep.tmp.ts\n");
        for (const path of ["src/build/compiler.ts", "src/keep.tmp.ts", "src/skip.tmp.ts", "generated/output.ts", "node_modules/pkg/a.ts"]) await put(cwd, path);
        const ctx = createTestContext(cwd);
        const glob = await executeToolResult("glob", JSON.stringify({pattern: "**/*.ts"}), ctx, "glob");
        const grep = await executeToolResult("grep", JSON.stringify({pattern: "DISCOVERY_TOKEN", glob: "**/*.ts", output_mode: "files_with_matches"}), ctx, "grep");
        for (const output of [glob.modelContent, grep.modelContent]) {
            expect(output).toContain("src/build/compiler.ts");
            expect(output).toContain("src/keep.tmp.ts");
            expect(output).not.toContain("node_modules/pkg/a.ts");
            expect(output).not.toContain("generated/output.ts");
            expect(output).not.toContain("src/skip.tmp.ts");
        }
    });
});

test("搜索显式包含 ignore 和隐藏文件，但始终排除 Git 元数据", async () => {
    await withTempProject(async cwd => {
        await put(cwd, ".gitignore", "generated/\n");
        for (const path of ["generated/a.ts", ".config/a.ts", ".git/a.ts"]) await put(cwd, path);
        const ctx = createTestContext(cwd);
        for (const name of ["glob", "grep"]) {
            const result = await executeToolResult(name, JSON.stringify({pattern: name === "glob" ? "**/*.ts" : "DISCOVERY_TOKEN",
                include_ignored: true, include_hidden: true}), ctx, name);
            expect(result.modelContent).toContain("generated/a.ts");
            expect(result.modelContent).toContain(".config/a.ts");
            expect(result.modelContent).not.toContain(".git/a.ts");
        }
    });
});

test("从子目录搜索继承项目 ignore，显式文件可单独检查", async () => {
    await withTempProject(async cwd => {
        await put(cwd, ".gitignore", "*.generated.ts\n");
        await put(cwd, "src/a.generated.ts");
        await put(cwd, "src/a.ts");
        const ctx = createTestContext(cwd);
        const result = await executeToolResult("grep", JSON.stringify({pattern: "DISCOVERY_TOKEN", path: "src"}), ctx, "subdir");
        expect(result.modelContent).toContain("src/a.ts");
        expect(result.modelContent).not.toContain("src/a.generated.ts");
        const explicit = await executeToolResult("grep", JSON.stringify({pattern: "DISCOVERY_TOKEN", path: "src/a.generated.ts"}), ctx, "explicit");
        expect(explicit.modelContent).toContain("src/a.generated.ts");
    });
});

test("240 个依赖文件不占用项目候选预算，搜索记录真实扫描数量", async () => {
    await withTempProject(async cwd => {
        for (let index = 0; index < 240; index++) await put(cwd, `node_modules/pkg/${index}.ts`);
        await put(cwd, "src/a.ts");
        await put(cwd, "src/build/b.ts");
        const ctx = createTestContext(cwd);
        const result = await executeToolResult("grep", JSON.stringify({pattern: "DISCOVERY_TOKEN"}), ctx, "count-candidates");
        expect(result.modelContent).toContain("Searched 2 files");
        expect(result.modelContent).toContain("found 2 candidate files");
        const glob = await executeToolResult("glob", JSON.stringify({pattern: "**/*.ts"}), ctx, "glob-candidates");
        expect(contentText(glob.modelContent).split("\n")).toEqual(["src/a.ts", "src/build/b.ts"]);
    });
});

test("fast 分页提前停止读取，complete 分页仍统计全部匹配", async () => {
    await withTempProject(async cwd => {
        for (let index = 0; index < 10; index++) await put(cwd, `${index}.txt`);
        const ctx = createTestContext(cwd);
        const input = {pattern: "DISCOVERY_TOKEN", head_limit: 1};
        const fast = await executeToolResult("grep", JSON.stringify(input), ctx, "fast");
        expect(fast.modelContent).toContain("Searched 1 files");
        expect(fast.modelContent).toContain("search coverage is incomplete");
        const complete = await executeToolResult("grep", JSON.stringify({...input, search_mode: "complete"}), ctx, "complete");
        expect(complete.modelContent).toContain("Total: 10 matches");
        expect(complete.modelContent).toContain("Searched 10 files");
        expect(complete.modelContent).not.toContain("search coverage is incomplete");
    });
});

test("跳过大文件时未找到不能暗示全范围不存在", async () => {
    await withTempProject(async cwd => {
        await put(cwd, "large.txt", "x".repeat(1024 * 1024 + 1));
        const result = await executeToolResult("grep", JSON.stringify({pattern: "ABSENT"}), createTestContext(cwd), "large-skip");
        expect(result.modelContent).toContain("No matches for");
        expect(result.modelContent).toContain("skipped 1 files");
        expect(result.modelContent).toContain("search coverage is incomplete");
    });
});

test("路径 brace glob、basename 多模式和隐藏开关在同一匹配器下工作", async () => {
    await withTempProject(async cwd => {
        for (const path of ["src/a.ts", "src/b.tsx", "src/c.py", ".hidden/a.ts"]) await put(cwd, path);
        const ctx = createTestContext(cwd);
        for (const glob of ["src/*.{ts,tsx}", "*.ts,*.tsx"]) {
            const result = await executeToolResult("grep", JSON.stringify({pattern: "DISCOVERY_TOKEN", glob}), ctx, glob);
            expect(result.modelContent).toContain("src/a.ts");
            expect(result.modelContent).toContain("src/b.tsx");
            expect(result.modelContent).not.toContain("src/c.py");
            expect(result.modelContent).not.toContain(".hidden/a.ts");
        }
    });
});

import {createFileDiscovery} from "../../src/tools/shared/fileDiscovery.js";
import {symlink} from "node:fs/promises";

test("文件枚举达到目录项上限可报告未完成，取消不继续递归", async () => {
    await withTempProject(async cwd => {
        for (let index = 0; index < 8; index++) await put(cwd, `${index}.txt`);
        const controller = new AbortController();
        const discovery = createFileDiscovery({cwd, root: cwd, signal: controller.signal,
            includeHidden: false, includeIgnored: false, maxEntries: 2, canVisit: async () => true});
        for await (const _file of discovery.files) { /* exhaust the bounded scan */ }
        expect(discovery.getStats()).toMatchObject({visitedEntries: 2, truncated: true});
        const cancelled = createFileDiscovery({cwd, root: cwd, signal: controller.signal,
            includeHidden: false, includeIgnored: false, maxEntries: 20_000, canVisit: async () => true});
        await cancelled.files.next();
        controller.abort("user-cancel");
        await expect(cancelled.files.next()).rejects.toThrow();
    });
});

test("坏 ignore 和 symlink ignore 拒绝搜索，不静默放宽过滤", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        await put(cwd, ".gitignore", "x".repeat(64 * 1024 + 1));
        const oversized = await executeToolResult("glob", JSON.stringify({pattern: "**/*"}), ctx, "bad-ignore");
        expect(oversized.outcome).toBe("failed");
        await writeFile(join(cwd, ".gitignore"), "");
        await put(cwd, "nested/placeholder");
        await symlink(join(cwd, ".gitignore"), join(cwd, "nested/.gitignore"));
        const linked = await executeToolResult("grep", JSON.stringify({pattern: "x", path: "nested"}), ctx, "linked-ignore");
        expect(linked.outcome).toBe("failed");
    });
});

test("被排除父目录中的局部反忽略不能重新引入子文件", async () => {
    await withTempProject(async cwd => {
        await put(cwd, ".gitignore", "generated/\n");
        await put(cwd, "generated/.gitignore", "!a.ts\n");
        await put(cwd, "generated/a.ts");
        const ctx = createTestContext(cwd);
        const hidden = await executeToolResult("glob", JSON.stringify({pattern: "*.ts", path: "generated"}), ctx, "hidden-root");
        expect(hidden.modelContent).not.toContain("generated/a.ts");
        const included = await executeToolResult("glob", JSON.stringify({pattern: "*.ts", path: "generated", include_ignored: true}), ctx, "include-root");
        expect(included.modelContent).toContain("generated/a.ts");
    });
});
