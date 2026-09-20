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

test("native rg file discovery and content search share repository ignores and nested exceptions", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, ".git"));
        await put(cwd, ".gitignore", "generated/\nnode_modules/\n*.tmp.ts\n");
        await put(cwd, "src/.gitignore", "!keep.tmp.ts\n");
        for (const path of ["src/build/compiler.ts", "src/keep.tmp.ts", "src/skip.tmp.ts", "generated/output.ts", "node_modules/pkg/a.ts", ".hidden/a.ts"]) await put(cwd, path);
        const ctx = createTestContext(cwd);
        for (const command of ["rg --files -t ts .", "rg -l -e DISCOVERY_TOKEN -t ts ."]) {
            const result = await executeToolResult("bash", JSON.stringify({command}), ctx, command);
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain("src/build/compiler.ts");
            expect(result.modelContent).toContain("src/keep.tmp.ts");
            for (const excluded of ["node_modules/pkg/a.ts", "generated/output.ts", "src/skip.tmp.ts", ".hidden/a.ts"]) expect(result.modelContent).not.toContain(excluded);
        }
        const explicit = await executeToolResult("bash", JSON.stringify({command: "rg -n -H -e DISCOVERY_TOKEN src/skip.tmp.ts"}), ctx, "explicit");
        expect(explicit.modelContent).toContain("src/skip.tmp.ts:1:DISCOVERY_TOKEN");
        const hidden = await executeToolResult("bash", JSON.stringify({command: "rg --files --hidden --no-ignore -g '*.ts' -g '!.git/**' ."}), ctx, "hidden");
        expect(hidden.modelContent).toContain(".hidden/a.ts");
        expect(hidden.modelContent).toContain("generated/output.ts");
    });
});

test("native search supports non-Git ignores, quoted Unicode paths and literal patterns", async () => {
    await withTempProject(async cwd => {
        await put(cwd, ".ignore", "generated/\n");
        await put(cwd, "generated/no.ts");
        await put(cwd, "源码 space/[one].ts", "before\n-a[b].*\nafter\n");
        const ctx = createTestContext(cwd);
        const result = await executeToolResult("bash", JSON.stringify({command: "rg -n -F -C 1 -e '-a[b].*' '源码 space/[one].ts'"}), ctx, "literal");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("2:-a[b].*");
        expect(result.modelContent).toContain("before");
        const files = await executeToolResult("bash", JSON.stringify({command: "rg --files ."}), ctx, "files");
        expect(files.modelContent).not.toContain("generated/no.ts");
        expect(files.modelContent).toContain("源码 space/[one].ts");
        const empty = await executeToolResult("bash", JSON.stringify({command: "rg -e ABSENT '源码 space'"}), ctx, "empty");
        expect(empty.outcome).toBe("ok");
        expect(empty.modelContent).toContain("rg exit code 1");
    });
});
