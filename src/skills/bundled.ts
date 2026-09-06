// 内置 skill 加载器
// 参考 claude-code src/skills/bundledSkills.ts 的 registerBundledSkill + initBundledSkills
//
// 简化点：claude-code 有 17+ 个内置 skill，用 registerBundledSkill 注册到全局 Map，
// getPromptForCommand 程序化构造（可以动态拼接 args）。
// 当前只内置 debug；验证由主 Agent 根据原始任务做最小充分检查，严格
// 日常验证由主 Agent 负责，不默认注入额外 verify 工作流。
//
// bundled skill 优先级最低：用户或项目仍可定义自己的同名/额外 Skill。

import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {LoadedSkill} from "./types.js";
import {parseFrontmatter} from "./frontmatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(__dirname, "bundled-files");

// 内置 skill 名字 → markdown 文件名
const BUNDLED_SKILLS = ["debug"] as const;

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
