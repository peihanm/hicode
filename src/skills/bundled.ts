import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {LoadedSkill} from "./types.js";
import {parseFrontmatter} from "./frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(__dirname, "bundled-files");

// 内置 skill 名字 → markdown 文件名
const BUNDLED_SKILLS: readonly string[] = [];

export function loadBundledSkills(): LoadedSkill[] {
    const skills: LoadedSkill[] = [];
    for (const name of BUNDLED_SKILLS) {
        const filePath = join(BUNDLED_DIR, `${name}.md`);
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
