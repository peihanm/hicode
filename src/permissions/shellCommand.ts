interface ShellSegment {
    raw: string;
    tokens: string[];
    next?: ";" | "&&" | "||" | "|";
}

/** Only literal simple commands are statically authorizable; expansion is never executed. */
export function parseShellCommand(command: string): {segments: ShellSegment[]; literal: boolean} {
    const segments: ShellSegment[] = [];
    let tokens: string[] = [];
    let word = "";
    let inWord = false;
    let quote: "single" | "double" | undefined;
    let literal = true;
    let start = 0;
    let needsCommand = false;
    const finishWord = () => {
        if (inWord) tokens.push(word);
        word = "";
        inWord = false;
    };
    const finishSegment = (end: number) => {
        finishWord();
        if (tokens.length) segments.push({raw: command.slice(start, end).trim(), tokens});
        tokens = [];
    };
    for (let i = 0; i < command.length; i++) {
        const char = command[i]!;
        if (char === "\\" && quote !== "single") {
            const next = command[++i];
            if (next === undefined) { literal = false; break; }
            if (next === "\n") continue;
            // In double quotes Bash only removes a backslash before these characters.
            if (quote === "double" && !['$', '`', '"', "\\"].includes(next)) word += "\\";
            word += next;
            inWord = true;
            continue;
        }
        if (char === "'" && quote !== "double") {
            quote = quote === "single" ? undefined : "single";
            inWord = true;
            continue;
        }
        if (char === '"' && quote !== "single") {
            quote = quote === "double" ? undefined : "double";
            inWord = true;
            continue;
        }
        if (quote !== "single" && (char === "$" || char === "`")) literal = false;
        if (!quote) {
            if (("<>(){}*?[]~".includes(char) || (char === "&" && command[i + 1] !== "&")) || (char === "#" && !inWord)) literal = false;
            const pair = command.slice(i, i + 2);
            if (char === ";" || char === "|" || char === "\n" || pair === "&&") {
                const hadCommand = inWord || tokens.length > 0;
                if (char === "\n" && !hadCommand && needsCommand) continue;
                if (!hadCommand && (needsCommand || char !== "\n")) literal = false;
                finishSegment(i);
                if (segments.length) segments[segments.length - 1]!.next = pair === "&&" || pair === "||" ? pair : char === "|" ? "|" : ";";
                needsCommand = char === "|" || pair === "&&";
                if (pair === "&&" || pair === "||") i++;
                start = i + 1;
                continue;
            }
            if (/\s/.test(char)) { finishWord(); continue; }
        }
        word += char;
        inWord = true;
        needsCommand = false;
    }
    if (quote || needsCommand) literal = false;
    finishSegment(command.length);
    // Control structures and assignments cannot be authorized as literal argv.
    if (segments.some(({tokens}) => !tokens[0] || /[=]/.test(tokens[0]) ||
        ["if", "then", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "!", "time"].includes(tokens[0]))) literal = false;
    return {segments, literal: literal && segments.length > 0};
}

export function splitShellSubCommands(command: string): string[] {
    return parseShellCommand(command).segments.map(segment => segment.raw);
}

const READ_ONLY_COMMANDS = new Set([
    "cat", "cd", "cut", "df", "du", "echo", "false", "grep", "head", "ls",
    "pwd", "rg", "sort", "stat", "tail", "test", "tree", "true", "tr",
    "uname", "uniq", "wc", "which", "whoami", "date", "file",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
    "describe", "diff", "grep", "log", "ls-files", "rev-parse", "show", "status",
]);

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

function unsafeOption(tokens: readonly string[], short: string, long: readonly string[]): boolean {
    return tokens.slice(1).some(token => {
        if (token.startsWith("--")) {
            const name = token.split("=", 1)[0]!.slice(2);
            // GNU tools accept unique long-option abbreviations.
            return !!name && long.some(flag => flag.startsWith(name) || name === flag);
        }
        return token.startsWith("-") && [...short].some(flag => token.slice(1).includes(flag));
    });
}

export function isShellArgvReadOnly(tokens: readonly string[]): boolean {
    const name = tokens[0];
    if (!name) return false;
    if (name === "git") {
        return READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1] ?? "") &&
            !unsafeOption(tokens, tokens[1] === "grep" ? "O" : "", [
                "output", "ext-diff", "textconv", "open-files-in-pager", "exec-path", "config-env",
            ]);
    }
    if (!READ_ONLY_COMMANDS.has(name)) return false;
    if ((name === "sort" || name === "tree") && unsafeOption(tokens, "o", ["output", "compress-program"])) return false;
    if (name === "rg" && unsafeOption(tokens, "", ["pre", "hostname-bin"])) return false;
    if (name === "file" && unsafeOption(tokens, "C", ["compile"])) return false;
    // date operands can set the clock; uniq's second operand is an output file.
    if (name === "date") return tokens.slice(1).every(token => token.startsWith("+") || ["-u", "--utc", "--universal", "-R", "--rfc-email", "-I", "--iso-8601"].includes(token));
    if (name === "uniq") {
        let optionsEnded = false;
        let operands = 0;
        for (const token of tokens.slice(1)) {
            if (!optionsEnded && token === "--") { optionsEnded = true; continue; }
            if (optionsEnded || token === "-" || !token.startsWith("-")) operands++;
        }
        return operands <= 1;
    }
    return true;
}

export function isShellCommandReadOnly(command: string): boolean {
    const parsed = parseShellCommand(command);
    return parsed.literal && parsed.segments.every(segment => isShellArgvReadOnly(segment.tokens));
}

export function generateShellAllowPattern(command: string): string | null {
    const parsed = parseShellCommand(command);
    if (!parsed.literal) return null;
    const prefixes = parsed.segments.map(({tokens}) => {
        const length = ["npm", "pnpm", "yarn", "bun"].includes(tokens[0]!) ? 3 : 2;
        const prefix = tokens.slice(0, length);
        // Rule patterns have their own wildcard grammar. Do not invent escaping for it.
        return prefix.every(token => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(token)) ? prefix.join(" ") : null;
    });
    return prefixes.every(prefix => prefix !== null) ? prefixes.map(prefix => `${prefix}:*`).join(" | ") : null;
}

export function isCompoundShellPattern(pattern: string): boolean {
    return splitShellSubCommands(pattern).length > 1;
}
