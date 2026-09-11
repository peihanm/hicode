// 已加载的 skill 实例
// 参考 claude-code src/skills/loadSkillsDir.ts 的 Command 类型，简化版
export type SkillFileSource = "user" | "project";

interface LoadedSkillContent {
    // skill 名（文件来源用目录名，Host 使用声明名称）
    name: string;

    // frontmatter.description — skill 用途，展示给 LLM 做选择
    description: string;

    // frontmatter.when_to_use — 何时使用（可选），跟 description 拼一起展示
    whenToUse?: string;

    // markdown body（frontmatter 之后的全部内容）
    // 调用 skill 时作为 tool_result 返回，LLM 下一轮读到并按它干活
    content: string;
}

export type LoadedSkill = LoadedSkillContent & (
    | {
        source: "bundled" | SkillFileSource;
        // 实际读取的 Markdown 文件绝对路径
        filePath: string;
    }
    | {
        source: "host";
        id: string;
    }
);
