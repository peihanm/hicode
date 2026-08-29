import {describe, expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {serializeMemoryFile} from "../../src/memory/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";

const timestamp = "2026-07-26T00:00:00.000Z";

describe("Memory file access", () => {
    test("主题是事实源，索引可以在两步写入中途自动修复", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            const memory = createTestMemoryRuntime(cwd, {directory});
            const access = memory.fileAccess("explicit");
            const topicPath = join(directory, "feedback-brief.md");
            const content = serializeMemoryFile(
                {
                    key: "feedback-brief",
                    name: "简洁回答",
                    description: "不要重复总结",
                    type: "feedback",
                    source: "explicit",
                    content: "回答结尾不要重复已经完成的内容。",
                },
                {createdAt: timestamp, updatedAt: timestamp}
            );

            await access.write(topicPath, content, null);
            expect(await memory.read("feedback-brief")).toBeDefined();
            expect(await memory.rebuildIndex()).toMatchObject({issues: []});
            expect(await readFile(join(directory, "MEMORY.md"), "utf8"))
                .toContain("feedback-brief.md");
            await memory.close();
        });
    });

    test("拒绝越界、坏 frontmatter 和 stale 写入", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            const memory = createTestMemoryRuntime(cwd, {directory});
            const access = memory.fileAccess("explicit");
            expect(access.classify(join(cwd, "outside.md"))).toBeUndefined();
            expect(() => access.validateWrite(
                join(directory, "broken.md"),
                "not frontmatter"
            )).toThrow();

            const topicPath = join(directory, "project-release.md");
            const content = serializeMemoryFile(
                {
                    key: "project-release",
                    name: "发布",
                    description: "发布日期",
                    type: "project",
                    source: "explicit",
                    content: "发布日期是 2026-08-01。",
                },
                {createdAt: timestamp, updatedAt: timestamp}
            );
            await access.write(topicPath, content, null);
            await expect(access.write(topicPath, content + "\n", null))
                .rejects.toThrow("必须重新读取");
            await memory.close();
        });
    });
});
