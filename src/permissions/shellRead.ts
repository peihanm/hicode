import {basename} from "node:path";
import {parseShellCommand} from "./shellCommand.js";

export interface ReadCommand {
    segments: Array<{program: string; args: string[]; next?: ";" | "&&" | "||" | "|"}>;
    paths: string[];
    kind: "search" | "files" | "directory" | "read";
    pattern?: string;
    singleSearch: boolean;
}

const RG_SWITCHES = new Set(["files", "files-with-matches", "files-without-match", "count", "count-matches",
    "line-number", "no-line-number", "with-filename", "no-filename", "heading", "no-heading", "hidden",
    "no-ignore", "no-ignore-vcs", "no-ignore-parent", "no-ignore-global", "no-ignore-dot", "no-config",
    "ignore-case", "case-sensitive", "smart-case", "fixed-strings", "word-regexp", "line-regexp",
    "invert-match", "only-matching", "multiline", "multiline-dotall", "crlf", "null", "null-data",
    "stats", "quiet", "no-messages", "follow", "no-follow", "json", "pcre2", "text", "version"]);
const RG_VALUES = new Set(["regexp", "glob", "iglob", "type", "type-not", "after-context", "before-context", "context",
    "max-count", "max-depth", "max-filesize", "encoding", "sort", "sortr", "color", "threads"]);
const RG_SHORT_VALUES: Record<string, string> = {e: "regexp", g: "glob", t: "type", T: "type-not", A: "after-context", B: "before-context", C: "context", m: "max-count", E: "encoding"};

/** A deliberately finite read-only grammar, not a Shell evaluator or an approval shortcut. */
export function analyzeReadCommand(command: string): ReadCommand | undefined {
    const parsed = parseShellCommand(command);
    if (command.includes("\0") || !parsed.literal || parsed.segments.length > 16) return undefined;
    const result: ReadCommand = {segments: [], paths: [], kind: "read", singleSearch: false};
    for (let segmentIndex = 0; segmentIndex < parsed.segments.length; segmentIndex++) {
        const segment = parsed.segments[segmentIndex]!;
        const original = segment.tokens[0]!;
        const program = basename(original);
        // Explicit executables are validated by the execution layer, not trusted by basename.
        if (!["rg", "ls", "pwd", "head", "tail", "wc", "cat", "echo"].includes(program)) return undefined;
        const args = segment.tokens.slice(1);
        const paths: string[] = [];
        let positional = false;
        let hasPattern = false;
        let files = false;
        let version = false;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            if (program === "echo") continue;
            if (!positional && arg === "--") {positional = true; continue;}
            if (!positional && arg.startsWith("-") && arg !== "-") {
                if (program === "rg") {
                    const option = (name: string, value?: string): boolean => {
                        if (RG_SWITCHES.has(name)) {
                            if (value !== undefined) return false;
                            files ||= name === "files";
                            version ||= name === "version";
                            return true;
                        }
                        if (!RG_VALUES.has(name)) return false;
                        value ??= args[++i];
                        if (value === undefined || value.includes("\0")) return false;
                        if (name === "regexp") {hasPattern = true; result.pattern ??= value;}
                        return true;
                    };
                    if (arg.startsWith("--")) {
                        const equal = arg.indexOf("=");
                        if (!option(arg.slice(2, equal < 0 ? undefined : equal), equal < 0 ? undefined : arg.slice(equal + 1))) return undefined;
                    } else {
                        for (let j = 1; j < arg.length; j++) {
                            const letter = arg[j]!;
                            const valueName = RG_SHORT_VALUES[letter];
                            if (valueName) {
                                if (!option(valueName, arg.slice(j + 1) || undefined)) return undefined;
                                break;
                            }
                            if (!"nNliIsSFwxcvoaUuHLh0qPV".includes(letter)) return undefined;
                            version ||= letter === "V";
                        }
                    }
                } else if (program === "ls") {
                    if (!/^-[1AaBbCcdFfGgHhikLlmnopqRrSsTtUuWwx@%]+$/.test(arg)) return undefined;
                } else if (program === "pwd") {
                    if (!/^-[LP]+$/.test(arg)) return undefined;
                } else if (program === "cat") {
                    if (!/^-[benstuvET]+$/.test(arg)) return undefined;
                } else if (program === "wc") {
                    if (!/^-[clmwL]+$/.test(arg)) return undefined;
                } else {
                    if (/^-\d+$/.test(arg)) continue;
                    if (!/^-[nc](?:\d+)?$/.test(arg)) return undefined;
                    if (arg.length === 2 && !/^\d+$/.test(args[++i] ?? "")) return undefined;
                }
            } else if (program === "pwd") return undefined;
            else if (program === "rg" && !hasPattern && !args.includes("--files") && !version) {
                hasPattern = true; result.pattern ??= arg;
            } else if (arg !== "-") paths.push(arg);
        }
        if (program === "rg") {
            if (!files && !version && !hasPattern) return undefined;
            if (!paths.length && !version && parsed.segments[segmentIndex - 1]?.next !== "|") paths.push(".");
            if (segmentIndex === 0) result.kind = files ? "files" : "search";
        } else if (program === "ls") {
            if (!paths.length) paths.push(".");
            if (segmentIndex === 0) result.kind = "directory";
        }
        result.paths.push(...paths);
        result.segments.push({program: original, args, ...(segment.next ? {next: segment.next} : {})});
    }
    result.singleSearch = result.segments.length === 1 && basename(result.segments[0]!.program) === "rg" && result.kind !== "read";
    return result;
}
