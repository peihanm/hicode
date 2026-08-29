const SHELL_SEPARATOR_RE = /\s*(?:&&|\|\||;|\|)\s*/;
const REDIRECTION_OR_SUBSTITUTION_RE = /(?:^|\s)(?:\d?>>|\d?>|<)|`|\$\(/;

const READ_ONLY_COMMANDS = new Set([
    "cat",
    "cd",
    "cut",
    "date",
    "df",
    "du",
    "echo",
    "false",
    "file",
    "grep",
    "head",
    "ls",
    "pwd",
    "rg",
    "sort",
    "stat",
    "tail",
    "test",
    "tree",
    "true",
    "tr",
    "uname",
    "uniq",
    "wc",
    "which",
    "whoami",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
    "describe",
    "diff",
    "grep",
    "log",
    "ls-files",
    "rev-parse",
    "show",
    "status",
]);

export function splitShellSubCommands(command: string): string[] {
    return command
        .split(SHELL_SEPARATOR_RE)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/**
 * Detect an unquoted shell background operator. `&&` and redirections such as
 * `&>`/`>&` are not background execution; quoted or escaped ampersands are
 * literal data. BashTool rejects this syntax because background processes must
 * be owned by TaskRuntime instead of escaping through an ordinary shell call.
 */
export function hasShellBackgroundOperator(command: string): boolean {
    let quote: "single" | "double" | undefined;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === "\\" && quote !== "single") {
            index += 1;
            continue;
        }
        if (char === "'" && quote !== "double") {
            quote = quote === "single" ? undefined : "single";
            continue;
        }
        if (char === '"' && quote !== "single") {
            quote = quote === "double" ? undefined : "double";
            continue;
        }
        if (char !== "&" || quote) continue;

        const previous = command[index - 1];
        const next = command[index + 1];
        if (previous === "&" || next === "&") continue;
        if (previous === ">" || next === ">") continue;
        return true;
    }
    return false;
}

function getShellCommandPrefix(command: string): string | null {
    const first = command.trim().split(/\s+/)[0];
    return first || null;
}

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/).filter(Boolean);
}

function isGitReadOnly(tokens: string[]): boolean {
    const subcommand = tokens[1];
    if (tokens.some((token) => token === "--output" || token.startsWith("--output="))) {
        return false;
    }
    return !!subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

export function isShellCommandReadOnly(command: string): boolean {
    if (hasShellBackgroundOperator(command)) return false;
    if (REDIRECTION_OR_SUBSTITUTION_RE.test(command)) return false;

    const subCommands = splitShellSubCommands(command);
    if (subCommands.length === 0) return false;

    return subCommands.every((subCommand) => {
        const tokens = tokenize(subCommand);
        const commandName = tokens[0];
        if (!commandName) return false;
        if (commandName === "git") return isGitReadOnly(tokens);
        return READ_ONLY_COMMANDS.has(commandName);
    });
}

export function generateShellAllowPattern(command: string): string | null {
    const subCommands = splitShellSubCommands(command);
    if (subCommands.length === 0) return null;

    const patterns = subCommands
        .map(getShellCommandPrefix)
        .filter((prefix): prefix is string => !!prefix)
        .map((prefix) => `${prefix}:*`);

    if (patterns.length === 0) return null;
    return patterns.join(" | ");
}

export function isCompoundShellPattern(pattern: string): boolean {
    return splitShellSubCommands(pattern).length > 1;
}
