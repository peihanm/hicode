import {readFileSync} from "node:fs";
import {realpath} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {LoadedSkill} from "./types.js";
import {parseFrontmatter} from "./frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(__dirname, "bundled-files");

const BUNDLED_SKILLS: readonly {readonly name: string; readonly files: readonly string[]}[] = [{
    name: "hicode-guide",
    files: ["SKILL.md", ...[
        "installation", "models", "commands", "permissions", "extensions", "troubleshooting",
        "configuration", "storage", "subagents", "mcp", "hooks", "sdk",
    ].map(name => `references/${name}.md`)],
}];

export function loadBundledSkills(): LoadedSkill[] {
    const skills: LoadedSkill[] = [];
    for (const {name} of BUNDLED_SKILLS) {
        const filePath = join(BUNDLED_DIR, name, "SKILL.md");
        const raw = readFileSync(filePath, "utf-8");
        const parsed = parseFrontmatter(raw);
        skills.push({
            name,
            description: parsed.description,
            whenToUse: parsed.whenToUse,
            content: parsed.body,
            source: "bundled",
            filePath,
        });
    }
    return skills;
}

/** Only shipped documentation of an effective bundled Skill can cross a workspace read boundary. */
export async function isBundledSkillFile(skills: readonly LoadedSkill[], path: string): Promise<boolean> {
    const target = resolve(path);
    for (const definition of BUNDLED_SKILLS) {
        const root = join(BUNDLED_DIR, definition.name);
        if (!skills.some(skill => skill.source === "bundled" && skill.name === definition.name &&
            skill.filePath === join(root, "SKILL.md"))) continue;
        const file = definition.files.find(file => join(root, file) === target);
        if (!file) continue;
        // Reject redirected files/directories; the installation root itself may be reached through a symlink.
        return await realpath(target) === join(await realpath(BUNDLED_DIR), definition.name, file);
    }
    return false;
}
