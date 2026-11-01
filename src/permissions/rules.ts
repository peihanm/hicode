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

/** Generic matching: prefix:* respects a word boundary; otherwise only * is special. */
export function matchPattern(pattern: string, input: string): boolean {
    const prefixMatch = pattern.match(/^(.+):\*$/);
    if (prefixMatch) {
        const prefix = prefixMatch[1];
        return input === prefix || input.startsWith(prefix + " ");
    }

    const placeholder = "\u0000";
    const escaped = pattern.replace(/\*/g, placeholder)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = escaped.replace(new RegExp(placeholder, "g"), ".*");
    return new RegExp(`^${regex}$`, "s").test(input);
}
