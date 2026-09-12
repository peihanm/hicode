// Single parser entry point for permission rule strings.
// "bash(git status:*)" → { toolName: "bash", content: "git status:*" }
// "read_file", "read_file(*)" and "read_file()" all match the whole tool.
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
