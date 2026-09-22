import {describe, expect, test} from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {loadSkills} from "../../src/skills/loader.js";
import {getUserContextBlocks} from "../../src/prompt/attachments.js";
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
        `---\ndescription: ${description}\n---\n${name} body\n`
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
        const root = join(storage.hicodeHome, "skills", "with spaces");
        await mkdir(join(root, "references"), {recursive: true});
        await writeFile(join(root, "SKILL.md"), "---\ndescription: fixture\n---\nRead references/schema.md. Args: $ARGUMENTS");
        await writeFile(join(root, "references/schema.md"), "RESOURCE_BODY");
        const ctx = {...createTestContext(cwd), skills: loadSkills({storage, cwd, sources: ["user"]})};
        const result = await executeToolResult("skill", JSON.stringify({skill: "with spaces", args: "$&"}), ctx, "activate");
        expect(result.modelContent).toContain(JSON.stringify(root));
        expect(result.modelContent).toContain("user");
        expect(result.modelContent).toContain("Args: $&");
        expect(result.modelContent).toContain("Project paths remain relative to the working directory");
        const resource = await executeToolResult("read_file", JSON.stringify({path: join(root, "references/schema.md")}), ctx, "resource");
        expect(resource.modelContent).toContain("RESOURCE_BODY");
    });
});

test("Host inline Skill 给出来源身份，不能继承被覆盖文件 Skill 的目录", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(cwd, ".hicode/skills"), "review", "project");
        const skills = loadSkills({storage, cwd, sources: ["project"], hostSkills: [{name: "review", description: "host", content: "host body"}]});
        const result = await executeToolResult("skill", JSON.stringify({skill: "review"}), {...createTestContext(cwd), skills}, "host");
        expect(result.modelContent).toContain('"source":"host"');
        expect(result.modelContent).toContain('"id":"review"');
        expect(result.modelContent).not.toContain(join(cwd, ".hicode/skills/review"));
        expect(result.modelContent).toContain("no local resource directory");
    });
});

test("项目覆盖激活指向实际读取的 Markdown 文件", async () => {
    await withTempProject(async (cwd, storage) => {
        await writeSkill(join(storage.hicodeHome, "skills"), "review", "user");
        await writeSkill(join(cwd, ".hicode/skills"), "review", "project");
        const ctx = {...createTestContext(cwd), skills: loadSkills({storage, cwd, sources: ["user", "project"]})};
        const project = await executeToolResult("skill", JSON.stringify({skill: "review"}), ctx, "project");
        expect(project.modelContent).toContain('"source":"project"');
        expect(project.modelContent).toContain(join(cwd, ".hicode/skills/review/SKILL.md"));
        expect(project.modelContent).not.toContain(join(storage.hicodeHome, "skills/review"));
    });
});


test("未知 Skill 通过统一工具链报告 failed，并列出当前实际可用名称", async () => {
    await withTempProject(async (cwd, storage) => {
        const empty = await executeToolResult("skill", '{"skill":"verify"}', {...createTestContext(cwd), skills: []}, "missing-empty");
        expect(empty.outcome).toBe("failed");
        expect(empty.modelContent).toContain("Available skills: (none)");
        const skills = loadSkills({storage, cwd, sources: [], hostSkills: [{name: "project-review", description: "review", content: "Args: $ARGUMENTS"}]});
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
        expect(loadSkills({storage, cwd, sources: []})).toMatchObject([{name: "hicode-guide", source: "bundled"}]);
        await writeSkill(join(cwd, ".hicode/skills"), "debug", "project debugging");
        expect(loadSkills({storage, cwd, sources: ["project"]})).toMatchObject([
            {name: "hicode-guide", source: "bundled"},
            {name: "debug", source: "project", description: "project debugging"},
        ]);
    });
});

test("bundled guide loads progressively and reads exact references across a strict workspace boundary", async () => {
    await withTempProject(async (cwd, storage) => {
        const skills = loadSkills({storage, cwd, sources: []});
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
        const skills = loadSkills({storage, cwd, sources: []});
        const guide = skills.find(skill => skill.source === "bundled");
        if (!guide || guide.source !== "bundled") throw new Error("Missing bundled guide");
        const ctx = {...createTestContext(cwd, {workspaceBoundary: cwd}), skills};
        expect((await executeToolResult("write_file", JSON.stringify({path: guide.filePath, content: "changed"}), ctx, "write-guide")).outcome).toBe("denied");
        const adjacent = join(dirname(guide.filePath), "..", "..", "bundled.ts");
        expect((await executeToolResult("read_file", JSON.stringify({path: adjacent}), ctx, "adjacent")).outcome).toBe("denied");
        await expect(prepareCommandReadAccess(`rg --files '${dirname(guide.filePath)}'`, cwd, ctx)).rejects.toThrow();
        await writeSkill(join(cwd, ".hicode/skills"), "hicode-guide", "Project-specific guide");
        ctx.skills = loadSkills({storage, cwd, sources: ["project"]});
        expect(ctx.skills.find(skill => skill.name === "hicode-guide")?.source).toBe("project");
        expect((await executeToolResult("read_file", JSON.stringify({path: guide.filePath}), ctx, "overridden")).outcome).toBe("denied");
    });
});
