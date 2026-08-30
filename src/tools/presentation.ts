import type {ToolOutcome} from "../toolResults/index.js";

export type ToolPhaseKind = "inspect" | "build" | "verify" | "service";

export interface ToolPhasePresentation {
    kind: ToolPhaseKind;
    label: string;
    activity: string;
    success: string;
    hidden?: boolean;
}

export interface ToolCallPresentation {
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

function stringArg(args: ParsedArgs, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanArg(args: ParsedArgs, key: string): boolean {
    return args[key] === true;
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

function taskDetail(args: ParsedArgs): string {
    const action = stringArg(args, "action") ?? "status";
    const taskId = stringArg(args, "task_id");
    return taskId ? `${action} ${taskId}` : action;
}

function quotedTarget(value: string): string {
    return truncate(JSON.stringify(value), 80);
}

function describeBashPhase(args: ParsedArgs): ToolPhasePresentation | undefined {
    const command = stringArg(args, "command") ?? "";
    const normalized = command.replace(/\r\n?/g, "\n").toLowerCase();
    if (booleanArg(args, "run_in_background")) {
        const looksLikeService =
            /\b(?:serve|server|vite|next\s+dev|http\.server)\b/.test(normalized) ||
            /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b/.test(normalized) ||
            /\bnode\s+[^\n;&|]*(?:server|app|index)\.(?:js|mjs|cjs|ts)\b/.test(normalized);
        return looksLikeService
            ? {
                kind: "service",
                label: "Starting service",
                activity: "Starting local service",
                success: "Service running",
            }
            : undefined;
    }
    if (
        /\bcurl\b[\s\S]*(?:127\.0\.0\.1|localhost|\[::1\])/.test(normalized)
    ) {
        const failsOnHttpError =
            /\bcurl\b[^\n;&|]*(?:--fail(?:-with-body)?\b|-[a-z]*f[a-z]*\b)/.test(normalized);
        return {
            kind: "verify",
            label: "Verifying",
            activity: "Checking local endpoints",
            success: failsOnHttpError
                ? "Local endpoint checks passed"
                : "Local endpoint checks completed",
        };
    }
    if (
        /\b(?:node|bun)\s+--check\b/.test(normalized) ||
        /\b(?:ast\.parse|py_compile|compileall)\b/.test(normalized)
    ) {
        return {
            kind: "verify",
            label: "Verifying",
            activity: "Checking syntax",
            success: "Syntax checks passed",
        };
    }
    if (
        /\b(?:bun|npm|pnpm|yarn)\s+(?:(?:run|exec)\s+)?(?:test|check|lint|typecheck|verify)\b/.test(normalized) ||
        /\b(?:pytest|vitest|jest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/.test(normalized)
    ) {
        return {
            kind: "verify",
            label: "Verifying",
            activity: "Running project checks",
            success: "Project checks passed",
        };
    }
    if (
        /\b(?:bun|npm|pnpm|yarn)\s+(?:(?:run|exec)\s+)?build\b/.test(normalized)
    ) {
        return {
            kind: "build",
            label: "Building",
            activity: "Building project",
            success: "Build completed",
        };
    }
    if (
        /(^|[;&|\n]\s*)(?:which|command\s+-v)\s+/.test(normalized) ||
        /\b(?:node|bun|python\d*|git|java|go|rustc)\s+(?:-v|--version|version)\b/.test(normalized)
    ) {
        return {
            kind: "inspect",
            label: "Inspecting project",
            activity: "Checking development environment",
            success: "Development environment checked",
        };
    }
    return undefined;
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
        case "list_files":
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: `Listing ${stringArg(args, "dir") ?? "."}`,
                success: `Listed ${stringArg(args, "dir") ?? "."}`,
            };
        case "read_file":
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: `Reading ${stringArg(args, "path") ?? "file"}`,
                success: `Read ${stringArg(args, "path") ?? "file"}`,
            };
        case "read_tool_result":
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: "Reading saved tool output",
                success: "Read saved tool output",
            };
        case "grep": {
            const target = stringArg(args, "pattern") ?? "pattern";
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: `Searching for ${quotedTarget(target)}`,
                success: `Searched for ${quotedTarget(target)}`,
            };
        }
        case "glob": {
            const target = stringArg(args, "pattern") ?? "pattern";
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: `Finding ${quotedTarget(target)}`,
                success: `Found paths for ${quotedTarget(target)}`,
            };
        }
        case "lsp":
            return {
                kind: "inspect",
                label: "Inspecting project",
                activity: "Querying code intelligence",
                success: "Code intelligence queried",
            };
        case "bash":
            return describeBashPhase(args);
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

    if (input.name === "bash") {
        if (phase.kind === "service") {
            const taskId = input.result?.match(/^Task:\s*(\S+)$/m)?.[1];
            return taskId ? `${phase.success} · task ${taskId}` : phase.success;
        }
        return phase.success;
    }

    if (input.name === "read_file" && input.result) {
        const detail = summarizeToolResult(
            input.name,
            input.result,
            input.outcome
        )[0];
        return detail?.startsWith("Read ")
            ? `${phase.success} · ${detail.slice(5)}`
            : phase.success;
    }
    if (
        input.result &&
        (input.name === "grep" ||
            input.name === "glob" ||
            input.name === "list_files")
    ) {
        const noResults = /^\s*(?:未找到|目录\s+.+\s+为空)/.test(input.result);
        if (noResults) return `${phase.success} · No results`;
        const count = normalizeDisplayLines(input.result).filter(
            (line) => line.trim().length > 0
        ).length;
        return `${phase.success} · Found ${count} result${count === 1 ? "" : "s"}`;
    }
    return phase.success;
}

/**
 * 把稳定的 Tool Schema 转成与终端无关的用户语义。这里不决定颜色、缩进或
 * 折叠方式；UI 只消费 label/detail，不再猜任意 JSON 字段。
 */
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
        case "read_tool_result": {
            const target = stringArg(args, "result_id") ?? "tool result";
            return {label: "Read", detail: target};
        }
        case "grep": {
            const query = stringArg(args, "pattern") ?? "pattern";
            const scope = stringArg(args, "path");
            return {
                label: "Search",
                detail: `pattern: ${JSON.stringify(query)}${scope ? `, path: ${scope}` : ""}`,
            };
        }
        case "glob": {
            const query = stringArg(args, "pattern") ?? "pattern";
            const scope = stringArg(args, "path");
            return {
                label: "Search",
                detail: `glob: ${JSON.stringify(query)}${scope ? `, path: ${scope}` : ""}`,
            };
        }
        case "list_files": {
            const target = stringArg(args, "dir") ?? ".";
            return {label: "List", detail: target};
        }
        case "lsp": {
            const operation = stringArg(args, "operation") ?? "query";
            const target = stringArg(args, "filePath") ?? stringArg(args, "query");
            return {
                label: "LSP",
                detail: [operation, target].filter(Boolean).join(" "),
            };
        }
        case "tool_search":
            return {
                label: "Tool search",
                detail: stringArg(args, "query") ?? "",
            };
        case "bash":
            return {
                label: "Bash",
                detail: summarizeShellCommand(stringArg(args, "command") ?? ""),
            };
        case "bash_task":
            return {
                label: "Task",
                detail: taskDetail(args),
            };
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
        case "delete_file":
            return {
                label: "Delete",
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
        case "enter_plan_mode":
            return {label: "Enter plan mode", detail: ""};
        case "exit_plan_mode":
            return {label: "Exit plan mode", detail: ""};
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
                detail: genericDetail(args, argsJson),
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
}): boolean {
    const activity = describeToolPhase(input.name, input.args);
    if (!activity) return false;
    return input.status === "running" || input.outcome === "ok";
}

export function summarizeToolResult(
    name: string,
    result: string,
    outcome?: ToolOutcome
): string[] {
    if (name === "read_file") {
        const match = result.match(
            /^文件:\s*[^\n]+\n行范围:\s*(\d+)-(\d+)\s*\/\s*(\d+)/
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

    if (name === "grep" || name === "glob" || name === "list_files") {
        const lines = normalizeDisplayLines(result).filter(
            (line) => line.trim().length > 0
        );
        if (outcome === "ok" && lines.length > 1) {
            return [`Found ${lines.length} result${lines.length === 1 ? "" : "s"}`];
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
