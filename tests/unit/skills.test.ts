import {describe, expect, test} from "bun:test";
import {mkdir, writeFile, symlink} from "node:fs/promises";
import {dirname, join} from "node:path";
import {loadSkills} from "../../src/skills/loader.js";
import {parseFrontmatter} from "../../src/skills/frontmatter.js";
import {getUserContextBlocks} from "../../src/prompt/messages.js";
import {prepareCommandReadAccess} from "../../src/tools/bash/readAccess.js";
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
        `---\nname: ${name}\ndescription: ${description}\n---\n${name} body\n`
    );
}

describe("Skill file sources", () => {
    test("用户 Skill 只从 Host storage 加载且可独立关闭", async () => {
        await withTempProject(async (cwd, storage) => {
            await writeSkill(
                join(storage.hicodeHome, "skills"),
                "host-user-skill",
                "host user"
            );
            await writeSkill(
                join(cwd, ".hicode", "skills"),
                "project-skill",
                "project"
            );

            const projectOnly = loadSkills({
                storage,
                cwd,
                sources: ["project"],
            }).skills;
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
            }).skills;
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
                join(cwd, ".hicode", "skills"),
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
            }).skills;
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

test("Skill 使用声明名称选择和覆盖，资源根仍来自实际文件目录", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(storage.hicodeHome, "skills"), "westock-data", "user description");
        const root = join(cwd, ".hicode/skills/finance-resources");
        await mkdir(root, {recursive: true});
        const description = "金融市场数据查询；查询股票和财报时使用。";
        await writeFile(join(root, "SKILL.md"), `---\nname: westock-data\ndescription: ${description}\n---\nRead references/routing-guide.md.`);
        const {skills, issues} = loadSkills({cwd, storage, sources: ["user", "project"]});
        expect(issues).toEqual([]);
        expect(skills.filter(skill => skill.name === "westock-data")).toHaveLength(1);
        expect(getUserContextBlocks(skills).join("\n")).toContain(`westock-data: ${description}`);
        const ctx = {...createTestContext(cwd), skills};
        const result = await executeToolResult("skill", '{"skill":"westock-data"}', ctx, "declared");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain(JSON.stringify({resourceRoot: root}));
        expect((await executeToolResult("skill", '{"skill":"finance-resources"}', ctx, "directory")).outcome).toBe("failed");
        const duplicate = join(cwd, ".hicode/skills/other-directory");
        await mkdir(duplicate);
        await writeFile(join(duplicate, "SKILL.md"), "---\nname: westock-data\ndescription: duplicate\n---\nbody");
        expect(loadSkills({cwd, storage, sources: ["project"]}).issues[0]?.message).toContain("Duplicate Skill name");
    });
});

test("Skill 名称可省略但不能显式为空，旧使用条件不解析且正文换行保持原样", () => {
    expect(parseFrontmatter("---\ndescription: fixture\n---\nbody").name).toBeUndefined();
    expect(() => parseFrontmatter("---\nname: \ndescription: fixture\n---\nbody")).toThrow("Skill name");
    expect(() => parseFrontmatter("---\nname: fixture\n---\nbody")).toThrow("Skill description");
    expect(() => parseFrontmatter("---\nname: one\nname: two\ndescription: fixture\n---\nbody")).toThrow("Duplicate Skill field");
    expect(parseFrontmatter("---\r\nname: westock-data\r\ndescription: 金融查询，查询股票时使用。\r\nwhen_to_use: ignored\r\n---\r\nbody\r\nnext")).toEqual({
        name: "westock-data", description: "金融查询，查询股票时使用。", body: "body\r\nnext",
    });
});

test("未声明 name 的 Skill 按目录名加载和激活", async () => {
    await withTempProject(async (cwd, storage) => {
        const root = join(cwd, ".hicode/skills/westock-data");
        await mkdir(root, {recursive: true});
        await writeFile(join(root, "SKILL.md"), "---\ndescription: 查询金融数据\n---\nBODY");
        const {skills, issues} = loadSkills({cwd, storage, sources: ["project"]});
        expect(issues).toEqual([]);
        expect(skills.find(skill => skill.name === "westock-data")?.description).toBe("查询金融数据");
        const result = await executeToolResult("skill", '{"skill":"westock-data"}', {...createTestContext(cwd), skills}, "fallback");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain(JSON.stringify({resourceRoot: root}));
        expect(result.modelContent).toContain("BODY");
    });
});

test("激活 Skill 提供真实资源根且不会把参数替换串当 replacement 模板", async () => {
    await withTempProject(async (cwd, storage) => {
        const root = join(storage.hicodeHome, "skills", "with spaces");
        await mkdir(join(root, "references"), {recursive: true});
        await writeFile(join(root, "SKILL.md"), "---\nname: with spaces\ndescription: fixture\n---\nRead references/schema.md. Args: $ARGUMENTS");
        await writeFile(join(root, "references/schema.md"), "RESOURCE_BODY");
        const ctx = {...createTestContext(cwd), skills: loadSkills({storage, cwd, sources: ["user"]}).skills};
        const result = await executeToolResult("skill", JSON.stringify({skill: "with spaces", args: "$&"}), ctx, "activate");
        expect(result.modelContent).toContain(JSON.stringify(root));
        expect(result.modelContent).toContain(JSON.stringify({resourceRoot: root}));
        expect(result.modelContent).not.toContain('"filePath"');
        expect(result.modelContent).not.toContain('"source"');
        expect(result.modelContent).toContain("Args: $&");
        expect(result.modelContent).toContain("project paths remain relative to the working directory");
        const resource = await executeToolResult("read_file", JSON.stringify({path: join(root, "references/schema.md")}), ctx, "resource");
        expect(resource.modelContent).toContain("RESOURCE_BODY");
    });
});

test("Host inline Skill 不虚构资源目录或继承被覆盖文件 Skill 的目录", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(cwd, ".hicode/skills"), "review", "project");
        const skills = loadSkills({storage, cwd, sources: ["project"], hostSkills: [{name: "review", description: "host", content: "host body"}]}).skills;
        const result = await executeToolResult("skill", JSON.stringify({skill: "review"}), {...createTestContext(cwd), skills}, "host");
        expect(result.modelContent).not.toContain('"resourceRoot"');
        expect(result.modelContent).not.toContain(join(cwd, ".hicode/skills/review"));
        expect(result.modelContent).toContain("no local resource directory");
    });
});

test("项目覆盖激活使用实际生效 Skill 的资源目录", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(storage.hicodeHome, "skills"), "review", "user");
        await writeSkill(join(cwd, ".hicode/skills"), "review", "project");
        const ctx = {...createTestContext(cwd), skills: loadSkills({storage, cwd, sources: ["user", "project"]}).skills};
        const project = await executeToolResult("skill", JSON.stringify({skill: "review"}), ctx, "project");
        expect(project.modelContent).toContain(JSON.stringify({resourceRoot: join(cwd, ".hicode/skills/review")}));
        expect(project.modelContent).not.toContain(join(storage.hicodeHome, "skills/review"));
    });
});


test("未知 Skill 通过统一工具链报告 failed，并列出当前实际可用名称", async () => {
    await withTempProject(async (cwd, storage) => {
        const empty = await executeToolResult("skill", '{"skill":"verify"}', {...createTestContext(cwd), skills: []}, "missing-empty");
        expect(empty.outcome).toBe("failed");
        expect(empty.modelContent).toContain("Available skills: (none)");
        const skills = loadSkills({storage, cwd, sources: [], hostSkills: [{name: "project-review", description: "review", content: "Args: $ARGUMENTS"}]}).skills;
        const ctx = {...createTestContext(cwd), skills};
        const missing = await executeToolResult("skill", '{"skill":"verify"}', ctx, "missing");
        expect(missing.outcome).toBe("failed");
        expect(missing.modelContent).toContain("project-review");
        const loaded = await executeToolResult("skill", '{"skill":"project-review"}', ctx, "loaded");
        expect(loaded.outcome).toBe("ok");
        expect(loaded.modelContent).toContain("Args: ");
        expect(loaded.modelContent).not.toContain("$ARGUMENTS");
    });
});

test("product guide is bundled without restoring removed debug workflows", async () => {
    await withTempProject(async (cwd, storage) => {
        expect(loadSkills({storage, cwd, sources: []}).skills).toMatchObject([{name: "hicode-guide", source: "bundled"}]);
        await writeSkill(join(cwd, ".hicode/skills"), "debug", "project debugging");
        expect(loadSkills({storage, cwd, sources: ["project"]}).skills).toMatchObject([
            {name: "hicode-guide", source: "bundled"},
            {name: "debug", source: "project", description: "project debugging"},
        ]);
    });
});

test("bundled guide loads progressively and reads exact references across a strict workspace boundary", async () => {
    await withTempProject(async (cwd, storage) => {
        const skills = loadSkills({storage, cwd, sources: []}).skills;
        const guide = skills.find(skill => skill.name === "hicode-guide");
        if (!guide || guide.source !== "bundled") throw new Error("Missing bundled guide");
        const root = dirname(guide.filePath);
        const ctx = {...createTestContext(cwd, {workspaceBoundary: cwd, readOnlyTools: true,
            canUseTool: async () => {throw new Error("Unexpected approval request");}}), skills};
        const listing = getUserContextBlocks(skills).join("\n");
        expect(listing).toContain("hicode-guide");
        expect(listing).not.toContain("## Choose a reference");
        const loaded = await executeToolResult("skill", '{"skill":"hicode-guide"}', ctx, "guide");
        expect(loaded.outcome).toBe("ok");
        expect(loaded.modelContent).toContain(JSON.stringify(root));
        expect(loaded.modelContent).not.toContain("## Command reference");
        const path = join(root, "references", "commands.md");
        const result = await executeToolResult("read_file", JSON.stringify({path}), ctx, "guide-reference");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("## Command reference");
        const access = await prepareCommandReadAccess(`rg -n model '${path}'`, cwd, ctx);
        expect(access?.artifacts).toContain(path);
        expect(access?.artifactDirectories).toEqual([]);

        ctx.permissionRules.deny.push({toolName: "read_file", content: path, source: "host"});
        expect((await executeToolResult("read_file", JSON.stringify({path}), ctx, "denied-guide")).outcome).toBe("denied");
        await expect(prepareCommandReadAccess(`cat '${path}'`, cwd, ctx)).rejects.toThrow("restricted");
    });
});

test("bundled file access does not authorize installation writes, adjacent files or overridden guides", async () => {
    await withTempProject(async (cwd, storage) => {
        const skills = loadSkills({storage, cwd, sources: []}).skills;
        const guide = skills.find(skill => skill.source === "bundled");
        if (!guide || guide.source !== "bundled") throw new Error("Missing bundled guide");
        const ctx = {...createTestContext(cwd, {workspaceBoundary: cwd}), skills};
        expect((await executeToolResult("write_file", JSON.stringify({path: guide.filePath, content: "changed"}), ctx, "write-guide")).outcome).toBe("denied");
        const adjacent = join(dirname(guide.filePath), "..", "..", "bundled.ts");
        expect((await executeToolResult("read_file", JSON.stringify({path: adjacent}), ctx, "adjacent")).outcome).toBe("denied");
        await expect(prepareCommandReadAccess(`rg --files '${dirname(guide.filePath)}'`, cwd, ctx)).rejects.toThrow();
        await writeSkill(join(cwd, ".hicode/skills"), "hicode-guide", "Project-specific guide");
        ctx.skills = loadSkills({storage, cwd, sources: ["project"]}).skills;
        expect(ctx.skills.find(skill => skill.name === "hicode-guide")?.source).toBe("project");
        expect((await executeToolResult("read_file", JSON.stringify({path: guide.filePath}), ctx, "overridden")).outcome).toBe("denied");
    });
});

test("invalid Skills are isolated and diagnosed without activating their content", async () => {
    await withTempProject(async (cwd, storage) => {
        const base = join(cwd, ".hicode", "skills");
        await writeSkill(base, "healthy", "works");
        await writeSkill(base, "oversized", "too big");
        await writeFile(join(base, "oversized", "SKILL.md"), "x".repeat(65537));
        await writeSkill(base, "metadata", "x".repeat(501));
        const result = loadSkills({cwd, storage, sources: ["project"]});
        expect(result.skills.map(skill => skill.name)).toEqual(["hicode-guide", "healthy"]);
        expect(result.issues).toHaveLength(2);
        expect(result.issues.some(issue => issue.message.includes("size limit"))).toBe(true);
        expect(result.issues.some(issue => issue.message.includes("500"))).toBe(true);
    });
});

test("Skill catalog is bounded independently of body loading", async () => {
    await withTempProject(async (cwd, storage) => {
        const result = loadSkills({cwd, storage, sources: [], hostSkills: Array.from({length: 100}, (_, i) => ({name: `s${i}`, description: "x".repeat(500), content: "body"}))});
        expect(result.skills.length).toBeLessThan(33);
        expect(result.issues.length).toBeGreaterThan(60);
    });
});


test("Skill symlinks and excessive directory entries are reported instead of followed", async () => {
    await withTempProject(async (cwd, storage) => {
        const base = join(cwd, ".hicode", "skills");
        await writeSkill(base, "good", "safe");
        await symlink(join(base, "good"), join(base, "alias"));
        await mkdir(join(base, "leaf"));
        await symlink(join(base, "good", "SKILL.md"), join(base, "leaf", "SKILL.md"));
        const result = loadSkills({cwd, storage, sources: ["project"]});
        expect(result.skills.map(skill => skill.name)).toEqual(["hicode-guide", "good"]);
        expect(result.issues).toHaveLength(2);
        for (let i = 0; i < 254; i++) await writeFile(join(base, `extra-${i}`), "");
        const excessive = loadSkills({cwd, storage, sources: ["project"]});
        expect(excessive.skills.map(skill => skill.name)).toEqual(["hicode-guide"]);
        expect(excessive.issues.some(issue => issue.message.includes("256"))).toBe(true);
    });
});
