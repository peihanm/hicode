// Skill 加载器
// 参考 claude-code src/skills/loadSkillsDir.ts 的 getSkillDirCommands
//
// 简化点：
// - 只 3 个源：bundled（内置）/ user（~/.pillar/skills）/ project（.pillar/skills）
//   claude-code 还有 managed / additional / legacy / plugin / mcp 共 5+ 源
// - 不支持动态发现（文件操作时找新 skill）
// - 不支持条件激活（paths frontmatter）
// - 不支持单文件 .md，只支持目录格式 `<name>/SKILL.md`
// - sync 加载（用 readFileSync）：skills 影响 attachment 注入，必须在 runAgent 前完成
//   跟 LSP 不同——LSP 要 spawn 进程必须 async，skills 只是读几个本地文件
// - 优先级：project > user > bundled（project 覆盖 user 同名，bundled 最低）

import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import type {LoadedSkill} from "./types.js";
import {parseFrontmatter} from "./frontmatter.js";
import {loadBundledSkills} from "./bundled.js";

export function loadSkills(cwd: string): LoadedSkill[] {
    const userDir = join(homedir(), ".pillar", "skills");
    const projectDir = join(cwd, ".pillar", "skills");

    // 目录不存在时静默返回空数组（用户没装 skill 不报错）
    const userSkills = loadSkillsFromDir(userDir, "user");
    const projectSkills = loadSkillsFromDir(projectDir, "project");
    const bundledSkills = loadBundledSkills();

    // 合并：bundled → user → project，后者覆盖前者同名
    const merged = new Map<string, LoadedSkill>();
    for (const s of [...bundledSkills, ...userSkills, ...projectSkills]) {
        merged.set(s.name, s);
    }
    return [...merged.values()];
}

function loadSkillsFromDir(
    basePath: string,
    source: "user" | "project"
): LoadedSkill[] {
    if (!existsSync(basePath)) return [];

    let entries;
    try {
        entries = readdirSync(basePath, {withFileTypes: true});
    } catch {
        return [];
    }

    const skills: LoadedSkill[] = [];
    for (const entry of entries) {
        // 只支持目录格式：<basePath>/<skill-name>/SKILL.md
        // 不支持单文件 .md（跟 claude-code 一致）
        if (!entry.isDirectory()) continue;

        const skillDir = join(basePath, entry.name);
        const skillFile = join(skillDir, "SKILL.md");

        let stat;
        try {
            stat = statSync(skillFile);
        } catch {
            continue; // 没有 SKILL.md，跳过
        }
        if (!stat.isFile()) continue;

        const raw = readFileSync(skillFile, "utf-8");
        const parsed = parseFrontmatter(raw);
        skills.push({
            name: entry.name,
            description: parsed.description,
            whenToUse: parsed.whenToUse,
            content: parsed.body,
            source,
            baseDir: skillDir,
        });
    }
    return skills;
}
