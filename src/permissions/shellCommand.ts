const SHELL_SEPARATOR_RE = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;
const UNSAFE_READ_ONLY_FLAGS = new Map<string, ReadonlySet<string>>([
    ["rg", new Set(["--pre", "--hostname-bin"])],
    ["sort", new Set(["-o", "--output", "--compress-program"])],
    ["tree", new Set(["-o", "--output"])],
]);
const UNSAFE_READ_ONLY_GIT_FLAGS = new Set([
    "--ext-diff",
    "--textconv",
    "--open-files-in-pager",
]);

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
    const tokens = tokenize(command);
    if (tokens.length === 0) return null;
    const prefixLength =
        tokens[0] === "npm" || tokens[0] === "pnpm" ||
        tokens[0] === "yarn" || tokens[0] === "bun"
            ? Math.min(3, tokens.length)
            : Math.min(2, tokens.length);
    return tokens.slice(0, prefixLength).join(" ");
}

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/).filter(Boolean);
}

function hasUnsafeShellSyntax(command: string): boolean {
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
        if (quote === "single") continue;
        if (char === "`" || (char === "$" && command[index + 1] === "(")) {
            return true;
        }
        if (!quote && (char === ">" || char === "<")) return true;
    }
    return false;
}

function hasUnsafeReadOnlyFlags(tokens: readonly string[]): boolean {
    const flags = tokens[0] ? UNSAFE_READ_ONLY_FLAGS.get(tokens[0]) : undefined;
    if (!flags) return false;
    return tokens.slice(1).some((token) =>
        flags.has(token) || [...flags].some((flag) => token.startsWith(`${flag}=`))
    );
}

function isGitReadOnly(tokens: string[]): boolean {
    const subcommand = tokens[1];
    if (tokens.some((token) =>
        token === "--output" || token.startsWith("--output=") ||
        UNSAFE_READ_ONLY_GIT_FLAGS.has(token) ||
        [...UNSAFE_READ_ONLY_GIT_FLAGS].some(
            (flag) => token.startsWith(`${flag}=`)
        )
    )) {
        return false;
    }
    return !!subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

export function isShellCommandReadOnly(command: string): boolean {
    if (hasShellBackgroundOperator(command)) return false;
    if (hasUnsafeShellSyntax(command)) return false;

    const subCommands = splitShellSubCommands(command);
    if (subCommands.length === 0) return false;

    return subCommands.every((subCommand) => {
        const tokens = tokenize(subCommand);
        const commandName = tokens[0];
        if (!commandName) return false;
        if (commandName === "git") return isGitReadOnly(tokens);
        return READ_ONLY_COMMANDS.has(commandName) && !hasUnsafeReadOnlyFlags(tokens);
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
