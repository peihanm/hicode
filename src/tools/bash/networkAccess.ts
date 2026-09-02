import {basename} from "node:path";
import {splitShellSubCommands} from "../../permissions/shellCommand.js";

export interface ShellNetworkRequirement {
    readonly reason: string;
    readonly domains: readonly string[];
}

const NODE_INSTALL_COMMANDS = new Set([
    "add",
    "ci",
    "i",
    "install",
    "update",
    "upgrade",
]);
const PYTHON_INSTALL_COMMANDS = new Set(["download", "install"]);
const OFFLINE_FLAGS = new Set(["--offline", "--cache-only"]);

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/).filter(Boolean);
}

function commandName(token: string | undefined): string | undefined {
    if (!token) return undefined;
    return basename(token).toLowerCase();
}

function optionUrlHostname(
    tokens: readonly string[],
    names: readonly string[]
): string | undefined {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        for (const name of names) {
            const value = token === name
                ? tokens[index + 1]
                : token.startsWith(`${name}=`)
                    ? token.slice(name.length + 1)
                    : undefined;
            if (!value) continue;
            try {
                return new URL(value).hostname.toLowerCase();
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

function firstPositional(
    tokens: readonly string[],
    start: number,
    optionsWithValues: ReadonlySet<string>
): string | undefined {
    for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (optionsWithValues.has(token)) {
            index += 1;
            continue;
        }
        if (token.startsWith("-")) continue;
        return token.toLowerCase();
    }
    return undefined;
}

function requirementForSubCommand(
    subCommand: string
): ShellNetworkRequirement | undefined {
    const tokens = tokenize(subCommand);
    if (tokens.some((token) => OFFLINE_FLAGS.has(token))) return undefined;
    let offset = 0;
    while (tokens[offset]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/)) offset += 1;
    if (commandName(tokens[offset]) === "env") {
        offset += 1;
        while (tokens[offset]?.match(/^[A-Za-z_][A-Za-z0-9_]*=/)) offset += 1;
    }

    const name = commandName(tokens[offset]);
    if (!name) return undefined;

    if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
        const subcommand = firstPositional(
            tokens,
            offset + 1,
            new Set([
                "--registry",
                "--cache",
                "--cwd",
                "--prefix",
                "--dir",
                "-C",
            ])
        );
        if (!subcommand || !NODE_INSTALL_COMMANDS.has(subcommand)) {
            return undefined;
        }
        const registry = optionUrlHostname(tokens, ["--registry"]);
        return {
            reason: `${name} ${subcommand}`,
            domains: [registry ?? "registry.npmjs.org"],
        };
    }

    if (name === "npx" || name === "bunx") {
        const registry = optionUrlHostname(tokens, ["--registry"]);
        return {
            reason: name,
            domains: [registry ?? "registry.npmjs.org"],
        };
    }

    const isPythonPip = (name === "python" || name === "python3") &&
        tokens[offset + 1] === "-m" && tokens[offset + 2] === "pip";
    if (name === "pip" || name === "pip3" || isPythonPip) {
        if (tokens.includes("--no-index")) return undefined;
        const commandOffset = isPythonPip ? offset + 3 : offset + 1;
        const subcommand = firstPositional(
            tokens,
            commandOffset,
            new Set(["--index-url", "--extra-index-url", "-i"])
        );
        if (!subcommand || !PYTHON_INSTALL_COMMANDS.has(subcommand)) {
            return undefined;
        }
        const indexHost = optionUrlHostname(tokens, ["--index-url", "-i"]);
        return {
            reason: `pip ${subcommand}`,
            domains: indexHost
                ? [indexHost]
                : ["pypi.org", "files.pythonhosted.org"],
        };
    }

    if (name === "uv") {
        const subcommand = firstPositional(
            tokens,
            offset + 1,
            new Set(["--index", "--default-index", "--index-url"])
        );
        if (!["add", "sync", "lock", "pip"].includes(subcommand ?? "")) {
            return undefined;
        }
        const indexHost = optionUrlHostname(tokens, [
            "--index",
            "--default-index",
            "--index-url",
        ]);
        return {
            reason: `uv ${subcommand}`,
            domains: indexHost
                ? [indexHost]
                : ["pypi.org", "files.pythonhosted.org"],
        };
    }

    if (name === "cargo") {
        const subcommand = firstPositional(tokens, offset + 1, new Set());
        if (!["add", "fetch", "install", "update"].includes(subcommand ?? "")) {
            return undefined;
        }
        return {
            reason: `cargo ${subcommand}`,
            domains: ["crates.io", "index.crates.io", "static.crates.io"],
        };
    }

    if (name === "go") {
        const subcommand = firstPositional(tokens, offset + 1, new Set());
        if (!["get", "install"].includes(subcommand ?? "") &&
            !(subcommand === "mod" && tokens[offset + 2] === "download")) {
            return undefined;
        }
        return {
            reason: `go ${subcommand}`,
            domains: ["proxy.golang.org", "sum.golang.org"],
        };
    }

    return undefined;
}

export function inferShellNetworkRequirement(
    command: string
): ShellNetworkRequirement | undefined {
    const requirements = splitShellSubCommands(command)
        .map(requirementForSubCommand)
        .filter((value): value is ShellNetworkRequirement => value !== undefined);
    if (requirements.length === 0) return undefined;
    return {
        reason: [...new Set(requirements.map((value) => value.reason))].join(", "),
        domains: [...new Set(requirements.flatMap((value) => value.domains))],
    };
}

function domainMatches(pattern: string, domain: string): boolean {
    const normalized = pattern.trim().toLowerCase();
    if (normalized === "*") return true;
    if (normalized.startsWith("*.")) {
        const suffix = normalized.slice(2);
        return domain === suffix || domain.endsWith(`.${suffix}`);
    }
    return normalized === domain;
}

export function missingAllowedDomains(
    requirement: ShellNetworkRequirement,
    allowedDomains: readonly string[]
): string[] {
    return requirement.domains.filter(
        (domain) => !allowedDomains.some((pattern) => domainMatches(pattern, domain))
    );
}
