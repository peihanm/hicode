// 已加载的 skill 实例
// 参考 claude-code src/skills/loadSkillsDir.ts 的 Command 类型，简化版
export type SkillFileSource = "user" | "project";

interface LoadedSkillContent {
    // skill 名（目录名，bundled 用 registerBundledSkill 的 name）
    name: string;

    // frontmatter.description — skill 用途，展示给 LLM 做选择
    description: string;

    // frontmatter.when_to_use — 何时使用（可选），跟 description 拼一起展示
    whenToUse?: string;

    // markdown body（frontmatter 之后的全部内容）
    // 调用 skill 时作为 tool_result 返回，LLM 下一轮读到并按它干活
    content: string;

    // skill 来源：bundled（内置）/ user（~/.pillar/skills）/ project（.pillar/skills）
}

export type LoadedSkill = LoadedSkillContent & (
    | {
        source: "bundled" | SkillFileSource;
        // SKILL.md 所在目录绝对路径
        baseDir: string;
    }
    | {
        source: "host";
        id: string;
    }
);
