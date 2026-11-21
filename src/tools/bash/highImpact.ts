import {homedir} from "node:os";
import {basename, dirname, parse as parsePath, resolve} from "node:path";
import {parse, type Command, type Node, type Word, type WordPart} from "unbash";

const shells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const downloaders = new Set(["curl", "wget"]);

function invocation(node: Command): Word[] {
    const words = node.name ? [node.name, ...node.suffix] : [];
    let i = 0;
    while (i < words.length) {
        const program = basename(words[i]!.value);
        if (program !== "env" && program !== "command" && program !== "sudo") break;
        i++;
        if (program === "env") while (words[i]?.value.match(/^[A-Za-z_][A-Za-z0-9_]*=/)) i++;
        if (words[i]?.value === "--") i++;
    }
    return words.slice(i);
}

function shortFlag(arg: string, flag: string): boolean {
    return /^-[a-zA-Z]+$/.test(arg) && arg.includes(flag);
}

function deletion(program: string, words: Word[], cwd: string, project: string): string | undefined {
    if (program === "find") {
        if (words.some(word => word.value === "-delete")) return "find -delete may remove every path matching its expression.";
        return;
    }
    let recursive = false, options = true;
    const targets: Word[] = [];
    for (const word of words) {
        const arg = word.value;
        if (options && arg === "--") {options = false; continue;}
        if (options && arg.startsWith("-") && arg !== "-") {
            recursive ||= arg === "--recursive" || shortFlag(arg, "r") || shortFlag(arg, "R");
        } else targets.push(word);
    }
    if (recursive && targets.length) return `Recursive deletion of ${targets.map(word => word.text).join(", ")}.`;
    for (const word of targets) {
        const target = resolve(cwd, word.value);
        if (target === resolve(project) || target === homedir() || dirname(target) === parsePath(target).root ||
            word.value === "." || word.value === ".." ||
            ["~", "$HOME", '"$HOME"', "${HOME}", '"${HOME}"'].includes(word.text) ||
            word.text === "*" || word.text.endsWith("/*")) {
            return `Deletion targets a protected directory or a whole-directory pattern: ${word.text}.`;
        }
    }
}

function gitRisk(args: string[]): string | undefined {
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) {
        const option = args[i++]!;
        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) i++;
    }
    const subcommand = args[i++];
    const rest = args.slice(i);
    const separator = rest.indexOf("--");
    const opts = separator < 0 ? rest : rest.slice(0, separator);
    if (subcommand === "reset" && opts.includes("--hard")) return "git reset --hard can discard uncommitted changes.";
    if (subcommand === "clean") {
        const flags = [];
        for (let j = 0; j < opts.length; j++) {
            const option = opts[j]!;
            if (option === "--exclude" || option === "-e") {j++; continue;}
            if (option.startsWith("--exclude=")) continue;
            // A bundled -e consumes the rest of its argument (or the next word).
            const e = /^-([a-zA-Z]*?)e(.*)$/.exec(option);
            if (e) {
                flags.push("-" + e[1]);
                if (!e[2]) j++;
            } else flags.push(option);
        }
        if (!flags.some(arg => arg === "--dry-run" || shortFlag(arg, "n") || arg === "--help" || arg === "-h")) {
            return "git clean may delete untracked files from the working tree.";
        }
    }
    if (subcommand === "restore") {
        const paths = separator < 0 ? rest : rest.slice(separator + 1);
        if (paths.some(path => path === "." || path === ":/" || path === "*" || path.endsWith("/") || path.endsWith("/*"))) {
            return "git restore may discard changes across a directory.";
        }
    }
}

function destination(args: string[]): string {
    const hosts = new Set<string>();
    for (const arg of args) {
        try {
            const url = new URL(arg.replace(/^--url=/, ""));
            if (url.host) hosts.add(url.host);
        } catch { /* Only display literal destinations, without credentials or query strings. */ }
    }
    return [...hosts].join(", ") || "the destination in the command";
}

function uploadRisk(program: string, args: string[]): string | undefined {
    const files = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--") break;
        const option = program === "wget"
            ? /^(--post-file|--body-file)(?:=(.*))?$/.exec(arg)
            : /^(--upload-file|--form|--data|--data-binary|--data-ascii|--data-urlencode|--json)(?:=(.*))?$/.exec(arg)
                ?? /^-([sSfLkivq]*[TFd])(.*)$/.exec(arg);
        if (!option) continue;
        const value = option[2] !== undefined && (arg.startsWith("--") || option[2] !== "") ? option[2] : args[++i];
        if (!value) continue;
        let file: string | undefined;
        const flag = arg.startsWith("--") ? option[1]! : "-" + option[1]!.at(-1);
        if (program === "wget" || ["--upload-file", "-T"].includes(flag)) file = value;
        else if (["--form", "-F"].includes(flag)) file = /^[^=]*=[@<](.+)/.exec(value)?.[1];
        else if (option[1] === "--data-urlencode") file = /^[^=@]*@(.+)/.exec(value)?.[1];
        else if (value.startsWith("@")) file = value.slice(1);
        if (file && file !== "-") files.add(file);
    }
    if (files.size) return `Upload local file data (${[...files].join(", ")}) to ${destination(args)}.`;
}

function readsShellStdin(args: string[]): boolean {
    for (const arg of args) {
        if (arg === "-s" || shortFlag(arg, "s")) return !args.some(a => shortFlag(a, "c"));
        if (arg === "--") return args.indexOf(arg) === args.length - 1;
        if (!arg.startsWith("-") || shortFlag(arg, "c")) return false;
    }
    return true;
}

/** Detect recognizable operations. No shell expansion, filesystem reads or command execution. */
export function bashOperationReview(command: string, cwd: string, project: string): string | undefined {
    const reasons = new Set<string>();
    function inspectParts(parts: readonly WordPart[] | undefined): void {
        for (const part of parts ?? []) {
            if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
                part.script?.commands.forEach(inspect);
            } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
                inspectParts(part.parts);
            }
        }
    }
    let nestedScripts = 0;
    function inspectScript(source: string): void {
        const script = parse(source);
        script.commands.forEach(inspect);
        if (script.errors?.length) reasons.add("The shell syntax could not be fully classified.");
    }
    function inspect(node: Node): void {
        switch (node.type) {
            case "Command": {
                const [head, ...words] = invocation(node);
                for (const word of [node.name, ...node.suffix]) inspectParts(word?.parts);
                if (!head) break;
                const program = basename(head.value);
                const args = words.map(word => word.value);
                let reason: string | undefined;
                if (["rm", "rmdir", "find"].includes(program)) reason = deletion(program, words, cwd, project);
                else if (program === "git") reason = gitRisk(args);
                else if (downloaders.has(program)) reason = uploadRisk(program, args);
                if (reason) reasons.add(reason);
                if (shells.has(program)) {
                    const flag = args.findIndex(arg => shortFlag(arg, "c"));
                    const script = flag >= 0 ? words[flag + 1] : undefined;
                    if (script && args.slice(0, flag).every(arg => arg.startsWith("-"))) {
                        if (++nestedScripts > 16) reasons.add("Nested shell commands require review.");
                        else if (script.parts?.some(part => part.type === "SimpleExpansion" || part.type === "ParameterExpansion")) reasons.add("The nested shell program is determined at runtime.");
                        else inspectScript(script.value);
                    }
                }
                break;
            }
            case "Pipeline": {
                for (let i = 1; i < node.commands.length; i++) {
                    const left = node.commands[i - 1]!, right = node.commands[i]!;
                    if (left.type !== "Command" || right.type !== "Command") continue;
                    const [from, ...source] = invocation(left), [to, ...args] = invocation(right);
                    if (from && to && downloaders.has(basename(from.value)) && shells.has(basename(to.value)) &&
                        readsShellStdin(args.map(arg => arg.value))) {
                        reasons.add(`Run the output from ${from.value} (${destination(source.map(word => word.value))}) in ${to.value}.`);
                    }
                }
                node.commands.forEach(inspect);
                break;
            }
            case "AndOr": case "CompoundList": node.commands.forEach(inspect); break;
            case "Statement": inspect(node.command); break;
            case "If": inspect(node.clause); inspect(node.then); if (node.else) inspect(node.else); break;
            case "While": inspect(node.clause); inspect(node.body); break;
            case "Case": node.items.forEach(item => inspect(item.body)); break;
            case "For": case "ArithmeticFor": case "Select": case "BraceGroup": case "Subshell":
            case "Coproc": case "Function": inspect(node.body); break;
        }
    }
    try {
        inspectScript(command);
    } catch {
        reasons.add("The shell syntax could not be fully classified.");
    }
    return reasons.size ? [...reasons].join("\n") : undefined;
}
