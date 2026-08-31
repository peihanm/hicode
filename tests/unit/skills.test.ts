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
            expect("baseDir" in review!).toBe(false);
        });
    });
});
