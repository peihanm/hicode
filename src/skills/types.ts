// A loaded Skill instance.
// Simplified from Claude Code's Command type in src/skills/loadSkillsDir.ts.
export type SkillFileSource = "user" | "project";

interface LoadedSkillContent {
    // Skill name: directory name for files, declared name for Host contributions.
    name: string;

    // frontmatter.description describes the Skill for model selection.
    description: string;

    // Optional frontmatter.when_to_use accompanies description.
    whenToUse?: string;

    // Markdown body after frontmatter.
    // Skill invocation returns this as a tool result for the next model request.
    content: string;
}

export type LoadedSkill = LoadedSkillContent & (
    | {
        source: "bundled" | SkillFileSource;
        // Absolute path of the Markdown file actually read.
        filePath: string;
    }
    | {
        source: "host";
        id: string;
    }
);
