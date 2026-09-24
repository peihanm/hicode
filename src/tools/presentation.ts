import {analyzeReadCommand} from "../permissions/shellRead.js";
import {stripVTControlCharacters} from "node:util";
import type {ToolOutcome} from "../toolResults/index.js";

type ToolPhaseKind = "inspect";

interface ToolPhasePresentation {
    kind: ToolPhaseKind;
    label: string;
    activity: string;
    success: string;
    hidden?: boolean;
}

interface ToolCallPresentation {
    label: string;
    detail: string;
}

interface ParsedArgs {
    [key: string]: unknown;
}

function parseArgs(argsJson: string): ParsedArgs {
    try {
        const value: unknown = JSON.parse(argsJson || "{}");
        return value !== null && typeof value === "object"
            ? value as ParsedArgs
            : {};
    } catch {
        return {};
    }
}

export function isBackgroundAgentCall(name: string, argsJson: string): boolean {
    return name === "agent" && parseArgs(argsJson).run_in_background === true;
}

function stringArg(args: ParsedArgs, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeShellCommand(command: string): string {
    const lines = command
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[\t ]+/g, " ").trim())
        .filter(Boolean);
    const visible = lines.slice(0, 2).join(" ⏎ ");
    const summary = truncate(visible, 160);
    return lines.length > 2 && !summary.endsWith("…") ? `${summary} …` : summary;
}

function genericDetail(args: ParsedArgs, raw: string): string {
    const entries = Object.entries(args)
        .slice(0, 3)
        .map(([key, value]) => {
            if (typeof value === "string") return `${key}=${truncate(value, 40)}`;
            if (typeof value === "number" || typeof value === "boolean") {
                return `${key}=${String(value)}`;
            }
            if (Array.isArray(value)) return `${key}=[${value.length}]`;
            if (value && typeof value === "object") return `${key}={…}`;
            return `${key}=${String(value)}`;
        });
    if (entries.length > 0) return entries.join(", ");
    return raw.trim() && raw.trim() !== "{}" ? truncate(raw.trim(), 120) : "";
}

function mcpDetail(args: ParsedArgs): string {
    return Object.entries(args).filter(([key]) => key !== "user_prompt").slice(0, 3).map(([key, value]) => {
        if (typeof value === "string" && (key === "code" || /[\r\n]/.test(value))) {
            const lines = value.trim() ? value.trim().split(/\r\n?|\n/).length : 0;
            return `${key}: ${lines} line${lines === 1 ? "" : "s"}`;
        }
        return genericDetail({[key]: value}, "");
    }).map(value => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ")).join(" · ");
}

function mcpResultLines(result: string): string[] {
    const lines = normalizeDisplayLines(result);
    // Some servers repeat their text result in a single structured `result` field.
    // Collapse only exact duplicates in the preview; the transcript keeps both.
    const last = lines.at(-1);
    if (lines.length > 1 && last && last.length <= 16_384) {
        try {
            const structured: unknown = JSON.parse(last);
            if (structured && typeof structured === "object" && !Array.isArray(structured) &&
                Object.keys(structured).length === 1 && "result" in structured && typeof structured.result === "string" &&
                structured.result.trim() === lines.slice(0, -1).join("\n").trim()) lines.pop();
        } catch { /* Keep non-JSON and distinct structured output. */ }
    }
    while (lines.at(-1)?.trim() === "") lines.pop();
    const preview = lines.slice(0, 3).map(line => {
        const image = line.match(/^\[Image image-[a-f0-9]+; (image\/[a-z0-9.+-]+); (\d+)×(\d+); [^\]\r\n]+\]$/);
        return image ? `Image · ${image[2]}×${image[3]} · ${image[1]!.slice(6).toUpperCase()}` : truncate(line, 220);
    });
    if (lines.length > 3 || preview.some((line, i) => line !== lines[i])) preview.push("ctrl+o to expand");
    return preview.length ? preview : ["Done"];
}

function taskDetail(args: ParsedArgs): string {
    const action = stringArg(args, "action") ?? "status";
    const taskId = stringArg(args, "task_id");
    return taskId ? `${action} ${taskId}` : action;
}

function quotedTarget(value: string): string {
    return truncate(JSON.stringify(value), 80);
}

/**
 * Default TUI phase semantics. Only deterministic, well-known operations are
 * grouped; unknown Bash/MCP calls keep their ordinary Tool row.
 */
export function describeToolPhase(
    name: string,
    argsJson: string
): ToolPhasePresentation | undefined {
    const args = parseArgs(argsJson);
    switch (name) {
        case "tool_search":
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: "Loading tools",
                success: "Tools loaded",
                hidden: true,
            };
        case "read_file":
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: `Reading ${stringArg(args, "path") ?? "file"}`,
                success: `Read ${stringArg(args, "path") ?? "file"}`,
            };
        case "bash": {
            const command = analyzeReadCommand(stringArg(args, "command") ?? "");
            if (!command || command.segments.length !== 1 || command.kind === "read") return undefined;
            const target = command.kind === "search" ? quotedTarget(command.pattern ?? "pattern") : command.paths.join(", ") || ".";
            const action = command.kind === "search" ? "Searching" : command.kind === "files" ? "Finding files in" : "Listing";
            const done = command.kind === "search" ? "Searched" : command.kind === "files" ? "Found files in" : "Listed";
            return {kind: "inspect", label: "Inspecting project", activity: `${action} ${target}`, success: `${done} ${target}`};
        }
        default:
            return undefined;
    }
}

export function summarizePhaseToolCall(input: {
    name: string;
    args: string;
    status: "running" | "done";
    outcome?: ToolOutcome;
    result?: string;
}): string | undefined {
    const phase = describeToolPhase(input.name, input.args);
    if (!phase || phase.hidden) return undefined;
    if (input.status === "running") return phase.activity;

    if (input.name === "read_file" && input.result) {
        const detail = summarizeToolResult(
            input.name,
            input.result
        )[0];
        return detail?.startsWith("Read ")
            ? `${phase.success} · ${detail.slice(5)}`
            : phase.success;
    }
    if (input.name === "bash" && input.result?.startsWith("No matches found (rg exit code 1).")) {
        return `${phase.success} · No results`;
    }
    return phase.success;
}

/** Project stable Tool Schema into terminal-independent user semantics. Color, indentation and folding belong elsewhere; the UI consumes label/detail rather than guessing arbitrary JSON fields. */
export function describeToolCall(
    name: string,
    argsJson: string
): ToolCallPresentation {
    const args = parseArgs(argsJson);
    switch (name) {
        case "read_file": {
            const target = stringArg(args, "path") ?? "file";
            return {label: "Read", detail: target};
        }
        case "tool_search":
            return {
                label: "Tool search",
                detail: stringArg(args, "query") ?? "",
            };
        case "bash": {
            const raw = stringArg(args, "command") ?? "";
            const command = analyzeReadCommand(raw);
            const kind = command?.segments.length === 1 ? command.kind : undefined;
            return {label: kind === "search" ? "Search" : kind === "files" ? "Find files" : kind === "directory" ? "List" : "Bash",
                detail: summarizeShellCommand(raw)};
        }
        case "agent_followup":
            return {label: "Continue Agent", detail: stringArg(args, "target") ?? ""};
        case "task":
            return {label: "Task", detail: taskDetail(args)};
        case "write_file":
            return {
                label: "Write",
                detail: stringArg(args, "path") ?? "file",
            };
        case "edit_file":
            return {
                label: "Edit",
                detail: stringArg(args, "path") ?? "file",
            };
        case "todo_write":
            return {label: "Update todos", detail: ""};
        case "ask_user": {
            const questions = args.questions;
            const count = Array.isArray(questions) ? questions.length : 0;
            return {
                label: "Ask user",
                detail: count > 0
                    ? `${count} question${count === 1 ? "" : "s"}`
                    : "",
            };
        }
        case "skill":
            return {
                label: "Skill",
                detail: stringArg(args, "skill") ?? "",
            };
        case "web_fetch":
            return {
                label: "Fetch",
                detail: stringArg(args, "url") ?? "URL",
            };
        case "agent":
            return {
                label: "Agent",
                detail: stringArg(args, "description") ?? "",
            };
        default:
            return {
                label: name.startsWith("mcp__")
                    ? name.replace(/^mcp__/, "MCP ").replaceAll("__", " · ")
                    : name,
                detail: name.startsWith("mcp__") ? mcpDetail(args) : genericDetail(args, argsJson),
            };
    }
}

function normalizeDisplayLines(result: string): string[] {
    const lines = result.replace(/\r\n?/g, "\n").split("\n");
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start]!.trim().length === 0) start += 1;
    while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
    return lines.slice(start, end);
}

export function isSuccessfulToolActivity(input: {
    name: string;
    args: string;
    status: "running" | "done";
    outcome?: ToolOutcome;
    result?: string;
}): boolean {
    const activity = describeToolPhase(input.name, input.args);
    if (!activity) return false;
    if (input.status === "running") return true;
    if (input.outcome !== "ok") return false;
    return true;
}

export function summarizeToolResult(
    name: string,
    result: string
): string[] {
    if (name.startsWith("mcp__")) return mcpResultLines(result);
    if (name === "read_file") {
        const match = result.match(
            /^File:\s*[^\n]+\nLine range:\s*(\d+)-(\d+)\s*\/\s*(\d+)/
        );
        if (match) {
            const start = Number(match[1]);
            const end = Number(match[2]);
            const total = Number(match[3]);
            const count = Math.max(0, end - start + 1);
            return [start === 1 && end === total
                ? `Read ${count} line${count === 1 ? "" : "s"}`
                : `Read lines ${start}-${end} of ${total}`];
        }
    }

    if (name === "web_fetch") {
        const status = result.match(/^HTTP:\s*(.+)$/m)?.[1];
        const url = result.match(/^URL:\s*(.+)$/m)?.[1];
        if (status) return [`${status}${url ? ` · ${url}` : ""}`];
    }

    if (name === "bash") {
        const lines = normalizeDisplayLines(result);
        if (lines.length === 0) return ["(no output)"];
        if (lines.length <= 4) return lines.map((line) => truncate(line, 220));
        return [
            ...lines.slice(0, 3).map((line) => truncate(line, 220)),
            `… +${lines.length - 3} lines (ctrl+o to expand)`,
        ];
    }

    const compact = result.replace(/\s*\n\s*/g, " ").trim();
    return compact ? [truncate(compact, 220)] : ["Done"];
}
