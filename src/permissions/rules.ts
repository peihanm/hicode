// 权限规则字符串的唯一解析入口。
// "bash(git status:*)" → { toolName: "bash", content: "git status:*" }
// "read_file" / "read_file(*)" / "read_file()" → 整工具匹配。
export function parsePermissionRule(rule: string): {
    toolName: string;
    content?: string;
} {
    const match = rule.match(/^(\w+)\((.*)\)$/);
    if (!match) return {toolName: rule};

    const [, toolName, content] = match;
    if (content === "*" || content === "") {
        return {toolName: toolName!};
    }
    return {toolName: toolName!, content};
}
