import {describe, expect, test} from "bun:test";
import {chmod, lstat, mkdir, readFile, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {MemoryStore, serializeMemoryFile} from "../../src/memory/index.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("MemoryStore", () => {
    test("创建、更新、扫描、索引重建和遗忘形成完整闭环", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            const store = new MemoryStore(directory);
            const created = await store.upsert({
                key: "user-typescript-level",
                name: "TypeScript 学习背景",
                description: "用户正在学习 TypeScript 框架代码",
                type: "user",
                source: "explicit",
                content: "用户希望用简洁、逐文件的方式学习 TypeScript。",
            });
            expect(created.action).toBe("created");
            const first = await store.read("user-typescript-level");
            expect(first?.content).toContain("逐文件");

            const updated = await store.upsert({
                key: "user-typescript-level",
                name: "TypeScript 学习背景",
                description: "用户正在学习 TypeScript 框架代码",
                type: "user",
                source: "explicit",
                content: "用户希望直接解释当前文件，不要无故先写学习文档。",
            });
            expect(updated.action).toBe("updated");
            const second = await store.read("user-typescript-level");
            expect(second?.createdAt).toBe(first?.createdAt);
            expect(second?.content).toContain("不要无故");

            const scan = await store.rebuildIndex();
            expect(scan.entries).toHaveLength(1);
            const index = await readFile(join(directory, "MEMORY.md"), "utf8");
            expect(index).toContain("user-typescript-level.md");
            expect(index).not.toContain(second!.content);
            expect((await lstat(directory)).mode & 0o777).toBe(0o700);
            expect((await lstat(second!.path)).mode & 0o777).toBe(0o600);

            expect((await store.forget("user-typescript-level"))?.action).toBe("forgotten");
            expect(await store.read("user-typescript-level")).toBeUndefined();
            expect(await readFile(join(directory, "MEMORY.md"), "utf8")).toBe("# Pillar Memory\n");
        });
    });

    test("坏文件和符号链接只形成 issue，不阻止其他主题加载", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            await mkdir(directory, {recursive: true});
            const store = new MemoryStore(directory);
            await store.upsert({
                key: "project-release",
                name: "发布背景",
                description: "发布冻结日期",
                type: "project",
                source: "explicit",
                content: "冻结日期是 2026-07-31。",
            });
            await writeFile(join(directory, "broken.md"), "not-frontmatter");
            await writeFile(join(cwd, "outside.md"), "outside");
            await symlink(join(cwd, "outside.md"), join(directory, "linked.md"));

            const scan = await store.list();
            expect(scan.entries.map((entry) => entry.key)).toEqual(["project-release"]);
            expect(scan.issues).toHaveLength(2);
        });
    });

    test("拒绝将 Memory 根目录本身作为符号链接", async () => {
        await withTempProject(async (cwd) => {
            const target = join(cwd, "target");
            const directory = join(cwd, "memory");
            await mkdir(target);
            await chmod(target, 0o755);
            await symlink(target, directory);
            const store = new MemoryStore(directory);
            await expect(store.upsert({
                key: "project-test",
                name: "test",
                description: "test",
                type: "project",
                source: "explicit",
                content: "test",
            })).rejects.toThrow("可信普通目录");
        });
    });

    test("扫描主题数量有硬上限并报告其余文件", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            await mkdir(directory);
            const timestamp = "2026-07-20T00:00:00.000Z";
            await Promise.all(
                Array.from({length: 201}, async (_, index) => {
                    const key = `topic-${String(index).padStart(3, "0")}`;
                    await writeFile(
                        join(directory, `${key}.md`),
                        serializeMemoryFile(
                            {
                                key,
                                name: key,
                                description: "bounded memory topic",
                                type: "project",
                                source: "explicit",
                                content: key,
                            },
                            {createdAt: timestamp, updatedAt: timestamp}
                        )
                    );
                })
            );

            const scan = await new MemoryStore(directory).list();
            expect(scan.entries).toHaveLength(200);
            expect(scan.issues.some((issue) => issue.message.includes("超过 200"))).toBe(true);
        });
    });
});
