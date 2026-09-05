import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {loadSkills} from "../../src/skills/loader.js";
import {withTempProject} from "../helpers/tempProject.js";

async function writeSkill(
    root: string,
    name: string,
    description: string
): Promise<void> {
    const directory = join(root, name);
    await mkdir(directory, {recursive: true});
    await writeFile(
        join(directory, "SKILL.md"),
        `---\ndescription: ${description}\n---\n${name} body\n`
    );
}

describe("Skill file sources", () => {
    test("用户 Skill 只从 Host storage 加载且可独立关闭", async () => {
        await withTempProject(async (cwd, storage) => {
            await writeSkill(
                join(storage.pillarHome, "skills"),
                "host-user-skill",
                "host user"
            );
            await writeSkill(
                join(cwd, ".pillar", "skills"),
                "project-skill",
                "project"
            );

            const projectOnly = loadSkills({
                storage,
                cwd,
                sources: ["project"],
            });
            expect(projectOnly.some((skill) =>
                skill.name === "project-skill"
            )).toBe(true);
            expect(projectOnly.some((skill) =>
                skill.name === "host-user-skill"
            )).toBe(false);

            const userOnly = loadSkills({
                storage,
                cwd,
                sources: ["user"],
            });
            expect(userOnly.some((skill) =>
                skill.name === "host-user-skill"
            )).toBe(true);
            expect(userOnly.some((skill) =>
                skill.name === "project-skill"
            )).toBe(false);
        });
    });

    test("inline Host Skill 覆盖同名文件 Skill", async () => {
        await withTempProject(async (cwd, storage) => {
            await writeSkill(
                join(cwd, ".pillar", "skills"),
                "review",
                "project review"
            );
            const skills = loadSkills({
                storage,
                cwd,
                sources: ["project"],
                hostSkills: [{
                    name: "review",
                    description: "host review",
                    content: "host body",
                }],
            });
            const review = skills.find((skill) => skill.name === "review");
            expect(review).toMatchObject({
                source: "host",
                id: "review",
                description: "host review",
                content: "host body",
            });
            expect("filePath" in review!).toBe(false);
        });
    });
});

import {executeToolResult} from "../helpers/executeTool.js";
import {createTestContext} from "../helpers/testContext.js";

test("激活 Skill 提供真实资源根且不会把参数替换串当 replacement 模板", async () => {
    await withTempProject(async (cwd, storage) => {
        const root = join(storage.pillarHome, "skills", "with spaces");
        await mkdir(join(root, "references"), {recursive: true});
        await writeFile(join(root, "SKILL.md"), "---\ndescription: fixture\n---\nRead references/schema.md. Args: $ARGUMENTS");
        await writeFile(join(root, "references/schema.md"), "RESOURCE_BODY");
        const ctx = {...createTestContext(cwd), skills: loadSkills({storage, cwd, sources: ["user"]})};
        const result = await executeToolResult("skill", JSON.stringify({skill: "with spaces", args: "$&"}), ctx, "activate");
        expect(result.modelContent).toContain(JSON.stringify(root));
        expect(result.modelContent).toContain("user");
        expect(result.modelContent).toContain("Args: $&");
        expect(result.modelContent).toContain("项目路径");
        const resource = await executeToolResult("read_file", JSON.stringify({path: join(root, "references/schema.md")}), ctx, "resource");
        expect(resource.modelContent).toContain("RESOURCE_BODY");
    });
});

test("Host inline Skill 给出来源身份，不能继承被覆盖文件 Skill 的目录", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(cwd, ".pillar/skills"), "review", "project");
        const skills = loadSkills({storage, cwd, sources: ["project"], hostSkills: [{name: "review", description: "host", content: "host body"}]});
        const result = await executeToolResult("skill", JSON.stringify({skill: "review"}), {...createTestContext(cwd), skills}, "host");
        expect(result.modelContent).toContain('"source":"host"');
        expect(result.modelContent).toContain('"id":"review"');
        expect(result.modelContent).not.toContain(join(cwd, ".pillar/skills/review"));
        expect(result.modelContent).toContain("没有本地资源目录");
    });
});

test("项目覆盖及 bundled 激活指向实际读取的 Markdown 文件", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(storage.pillarHome, "skills"), "review", "user");
        await writeSkill(join(cwd, ".pillar/skills"), "review", "project");
        const ctx = {...createTestContext(cwd), skills: loadSkills({storage, cwd, sources: ["user", "project"]})};
        const project = await executeToolResult("skill", JSON.stringify({skill: "review"}), ctx, "project");
        expect(project.modelContent).toContain('"source":"project"');
        expect(project.modelContent).toContain(join(cwd, ".pillar/skills/review/SKILL.md"));
        expect(project.modelContent).not.toContain(join(storage.pillarHome, "skills/review"));
        const bundled = await executeToolResult("skill", JSON.stringify({skill: "debug"}), ctx, "bundled");
        expect(bundled.modelContent).toContain("bundled-files/debug.md");
        expect(bundled.modelContent).not.toContain("debug/SKILL.md");
    });
});
