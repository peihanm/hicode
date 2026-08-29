// 简易 YAML frontmatter 解析器
// 参考 claude-code src/skills/loadSkillsDir.ts 的 parseSkillFrontmatterFields
//
// 简化点：claude-code 支持 16 个字段（description/when_to_use/name/allowed-tools/
// argument-hint/arguments/model/effort/user-invocable/disable-model-invocation/
// version/context/agent/hooks/shell/paths），用 yaml 包解析。
// 我们只解析 description + when_to_use 两个字段，自己 split，不引 yaml 包。
//
// 格式：
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

// frontmatter 块的分隔符：`---\n` 开头，`\n---\n` 结尾
const FRONTMATTER_START = "---\n";
const FRONTMATTER_END = "\n---\n";

export function parseFrontmatter(raw: string): ParsedFrontmatter {
    // 没有 frontmatter 块（老式 markdown，整个就是 body）
    if (!raw.startsWith(FRONTMATTER_START)) {
        return {description: "", body: raw};
    }

    const endIdx = raw.indexOf(FRONTMATTER_END, FRONTMATTER_START.length);
    if (endIdx === -1) {
        // frontmatter 开始了但没闭合，按无 frontmatter 处理
        return {description: "", body: raw};
    }

    const frontmatterBlock = raw.slice(FRONTMATTER_START.length, endIdx);
    const body = raw.slice(endIdx + FRONTMATTER_END.length);

    // 解析 frontmatter：只支持 `key: value` 单行格式
    // 多行值 / 列表 / 嵌套都不支持（YAGNI）
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
        // 其他字段（allowed-tools/paths/model 等）忽略
    }

    return {description, whenToUse, body};
}
