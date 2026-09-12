// Minimal YAML frontmatter parser.
// Based on parseSkillFrontmatterFields in Claude Code src/skills/loadSkillsDir.ts.
//
// Claude Code supports additional fields such as description, when_to_use, name and allowed-tools,
// argument-hint/arguments/model/effort/user-invocable/disable-model-invocation/
// plus version, context, agent, hooks, shell and paths using the yaml package.
// This parser splits only description and when_to_use without the yaml package.
//
// Format:
// ---
// description: xxx
// when_to_use: yyy
// ---
// <markdown body>

export interface ParsedFrontmatter {
    description: string;
    whenToUse?: string;
    body: string;
}

// Frontmatter starts with ---\n and ends with \n---\n.
const FRONTMATTER_START = "---\n";
const FRONTMATTER_END = "\n---\n";

export function parseFrontmatter(raw: string): ParsedFrontmatter {
    // Without frontmatter, all Markdown is body content.
    if (!raw.startsWith(FRONTMATTER_START)) {
        return {description: "", body: raw};
    }

    const endIdx = raw.indexOf(FRONTMATTER_END, FRONTMATTER_START.length);
    if (endIdx === -1) {
        // Treat an unclosed frontmatter block as plain Markdown.
        return {description: "", body: raw};
    }

    const frontmatterBlock = raw.slice(FRONTMATTER_START.length, endIdx);
    const body = raw.slice(endIdx + FRONTMATTER_END.length);

    // Only single-line key: value fields are parsed.
    // Multiline values, lists and nesting are unsupported.
    let description = "";
    let whenToUse: string | undefined;

    for (const line of frontmatterBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key === "description") {
            description = value;
        } else if (key === "when_to_use") {
            whenToUse = value;
        }
        // Ignore other fields such as allowed-tools, paths and model.
    }

    return {description, whenToUse, body};
}
