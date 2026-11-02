import {expect, test} from "bun:test";
import {readFile, readdir, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {FileCommitCoordinator} from "../../src/tools/files/io.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";

test("unrelated changes survive local edits; observing only a replacement cannot authorize a rewrite", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "code.txt");
        await writeFile(path, "target = 1\nother = original\n");
        const tools = createToolRuntime(), ctx = createTestContext(cwd);
        await executeDeliveredTool(tools, "read_file", JSON.stringify({path}), ctx, "read");
        await writeFile(path, "inserted externally\ntarget = 1\nother = changed\n");
        const edited = await tools.executeTool("edit_file", JSON.stringify({path, edits: [{old_string: "target = 1", new_string: "target = 2"}]}), ctx, "edit");
        expect(edited.outcome).toBe("ok");
        expect(edited.modelContent).toContain("other current content was preserved");
        expect(await readFile(path, "utf8")).toBe("inserted externally\ntarget = 2\nother = changed\n");
        expect((await tools.executeTool("write_file", JSON.stringify({path, content: "blind"}), ctx, "rewrite")).outcome).toBe("failed");
    });
});

test.each([false, true])("overlapping occurrences cannot masquerade as one match, replace_all=%s", async replaceAll => {
    await withTempProject(async cwd => {
        const path = join(cwd, "code.txt"); await writeFile(path, "ababa");
        const tools = createToolRuntime(), ctx = createTestContext(cwd);
        await executeDeliveredTool(tools, "read_file", JSON.stringify({path}), ctx, "read");
        const result = await tools.executeTool("edit_file", JSON.stringify({path, edits: [{old_string: "aba", new_string: "x", replace_all: replaceAll}]}), ctx, "edit");
        expect(result.outcome).toBe("failed");
        expect(result.modelContent).toContain(replaceAll ? "overlaps" : "matched 2 locations");
        expect(await readFile(path, "utf8")).toBe("ababa");
    });
});

test("mixed line endings, BOM and non-ASCII context survive local edits and no-ops", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "code.txt"), original = "\uFEFF头\r\nLF🙂\nCR\r尾";
        await writeFile(path, original);
        const tools = createToolRuntime(), ctx = createTestContext(cwd);
        const result = await tools.executeTool("edit_file", JSON.stringify({path, edits: [
            {old_string: "LF🙂", new_string: "LF新🙂\nextra"},
            {old_string: "CR", new_string: "CR新\nextra"},
        ]}), ctx, "edit");
        expect(result.outcome).toBe("ok");
        const expected = "\uFEFF头\r\nLF新🙂\nextra\nCR新\rextra\r尾";
        expect(await readFile(path, "utf8")).toBe(expected);
        const normalized = expected.replace(/\r\n?/g, "\n");
        const noop = await tools.executeTool("edit_file", JSON.stringify({path, edits: [{old_string: normalized, new_string: normalized}]}), ctx, "noop");
        expect(noop.uiData).toBeUndefined();
        expect(await readFile(path, "utf8")).toBe(expected);
    });
});

test.each(["deny", "ask"] as const)("read restrictions also protect implicit reads in edit/write: %s", async behavior => {
    await withTempProject(async cwd => {
        const path = join(cwd, "secret.txt"); await writeFile(path, "private");
        let prompts = 0;
        const ctx = createTestContext(cwd, {permissionMode: "ask", canUseTool: async () => {prompts++; return {behavior: "deny", message: "Do not read"};}});
        ctx.permissionRules[behavior].push({toolName: "read_file", content: path, source: "host"});
        const tools = createToolRuntime();
        for (const [name, input] of [["edit_file", {path, edits: [{old_string: "private", new_string: "other"}]}], ["write_file", {path, content: "other"}]] as const) {
            const result = await tools.executeTool(name, JSON.stringify(input), ctx, name);
            expect(result.outcome).toBe("denied");
            expect(result.uiData).toBeUndefined();
        }
        expect(prompts).toBe(behavior === "ask" ? 2 : 0);
        expect(await readFile(path, "utf8")).toBe("private");
    });
});

test("a competing write after matching still aborts the whole edit", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "code.txt"); await writeFile(path, "before");
        const coordinator = new FileCommitCoordinator(), commit = coordinator.run.bind(coordinator);
        coordinator.run = async (...args) => {await writeFile(path, "another writer"); return commit(...args);};
        const ctx = createTestContext(cwd, {fileCommits: coordinator});
        const result = await createToolRuntime().executeTool("edit_file", JSON.stringify({path, edits: [{old_string: "before", new_string: "after"}]}), ctx, "edit");
        expect(result.outcome).toBe("failed");
        expect(result.uiData).toBeUndefined();
        expect(await readFile(path, "utf8")).toBe("another writer");
        expect((await readdir(cwd)).some(name => name.startsWith(".hicode-write-"))).toBe(false);
    });
});

test("unread edits reject symlinks and invalid UTF-8 rather than reading or rewriting them", async () => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd, "target"), "before");
        await symlink(join(cwd, "target"), join(cwd, "alias"));
        await writeFile(join(cwd, "binary"), Buffer.from([98, 101, 102, 111, 114, 101, 255]));
        const tools = createToolRuntime(), ctx = createTestContext(cwd);
        for (const path of ["alias", "binary"]) {
            expect((await tools.executeTool("edit_file", JSON.stringify({path, edits: [{old_string: "before", new_string: "after"}]}), ctx, path)).outcome).toBe("failed");
        }
        expect(await readFile(join(cwd, "target"), "utf8")).toBe("before");
        expect(await readFile(join(cwd, "binary"))).toEqual(Buffer.from([98, 101, 102, 111, 114, 101, 255]));
    });
});
