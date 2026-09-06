import {expect, test} from "bun:test";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

test("空 Memory 根据上下文模板首次保存，缺 source 可修复且不会触发权限确认或污染文件", async () => {
    await withTempProject(async cwd => {
        const directory = join(cwd, "memory");
        const memory = createTestMemoryRuntime(cwd, {directory});
        try {
            const context = await memory.contextForTurn("请记住这个偏好");
            const raw = /```yaml\n([\s\S]*?)\n```/.exec(context.block ?? "")?.[1];
            expect(raw).toBeDefined();
            const content = raw! + "\n";
            const path = join(directory, "example-topic.md");
            const indexPath = join(directory, "MEMORY.md");
            const originalIndex = await readFile(indexPath, "utf8");
            expect(originalIndex.trim()).toBe("# Pillar Memory");
            let prompts = 0;
            const ctx = createTestContext(cwd, {permissionMode: "default",
                memoryFiles: memory.fileAccess("explicit"), canUseTool: async () => {
                    prompts++;
                    return {behavior: "deny", message: "unexpected permission request"};
                }});
            const tools = createToolRuntime();
            let call = 0;
            const execute = (name: string, input: object) => executeDeliveredTool(tools,
                name, JSON.stringify(input), ctx, `memory-${++call}`);
            const invalid = content.replace(/^source:.*\n/m, "");
            const failed = await execute("write_file", {path, content: invalid});
            expect(failed.outcome).toBe("failed");
            expect(failed.modelContent).toContain("source: 缺少必填字段");
            expect(failed.modelContent).toContain("explicit");
            expect(failed.modelContent).not.toContain("权限拒绝");
            expect(existsSync(path)).toBe(false);
            expect(await readFile(indexPath, "utf8")).toBe(originalIndex);
            expect((await memory.list()).entries).toHaveLength(0);

            expect((await execute("write_file", {path, content})).outcome).toBe("ok");
            expect((await memory.read("example-topic"))?.source).toBe("explicit");
            expect((await execute("read_file", {path: indexPath})).outcome).toBe("ok");
            expect((await execute("edit_file", {path: indexPath, edits: [{old_string: "# Pillar Memory",
                new_string: "# Pillar Memory\n\n- [示例主题](example-topic.md) — 本主题的用途"}]})).outcome).toBe("ok");
            expect((await memory.contextForTurn("继续")).block).toContain("[示例主题](example-topic.md)");

            const before = await readFile(path, "utf8");
            expect((await execute("write_file", {path, content: invalid})).outcome).toBe("failed");
            const badEdit = await execute("edit_file", {path, edits: [
                {old_string: "type: feedback", new_string: "type: user"},
                {old_string: "source: explicit", new_string: "source: invalid"},
            ]});
            expect(badEdit.outcome).toBe("failed");
            expect(badEdit.modelContent).toContain("source: 仅允许 explicit / automatic");
            expect(await readFile(path, "utf8")).toBe(before);
            expect(prompts).toBe(0);

            ctx.permissionRules.deny.push({toolName: "write_file", source: "project"});
            expect((await execute("write_file", {path, content})).outcome).toBe("denied");
            expect(await readFile(path, "utf8")).toBe(before);
        } finally {
            await memory.close();
        }
    });
});
