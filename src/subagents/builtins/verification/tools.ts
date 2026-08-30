import {resolve} from "node:path";
import type {PermissionResult} from "../../../permissions/index.js";
import {isShellCommandReadOnly} from "../../../permissions/shellCommand.js";
import {bashTool} from "../../../tools/bash/bash.js";
import {bashTaskTool} from "../../../tools/bash/bashTask.js";
import type {Tool} from "../../../tools/types.js";

interface ParsedShellCommand {
    segments: string[][];
    rejectedSyntax?: string;
}

const MAX_CURL_PROBES = 2;

const PACKAGE_SCRIPTS = new Set([
    "build",
    "check",
    "lint",
    "test",
    "typecheck",
    "verify",
]);

function parseShell(command: string): ParsedShellCommand {
    const rawSegments: string[] = [];
    let current = "";
    let quote: "single" | "double" | null = null;
    let escaped = false;

    const push = () => {
        const value = current.trim();
        if (value) rawSegments.push(value);
        current = "";
    };

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index]!;
        const next = command[index + 1];
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\" && quote !== "single") {
            current += char;
            escaped = true;
            continue;
        }
        if (quote === "single") {
            current += char;
            if (char === "'") quote = null;
            continue;
        }
        if (quote === "double") {
            current += char;
            if (char === '"') {
                quote = null;
            } else if (char === "`" || (char === "$" && next === "(")) {
                return {segments: [], rejectedSyntax: "命令替换"};
            }
            continue;
        }
        if (char === "'") {
            quote = "single";
            current += char;
            continue;
        }
        if (char === '"') {
            quote = "double";
            current += char;
            continue;
        }
        if (char === "`" || (char === "$" && next === "(")) {
            return {segments: [], rejectedSyntax: "命令替换"};
        }
        if (char === ">" || char === "<") {
            return {segments: [], rejectedSyntax: "重定向"};
        }
        if (char === "&" && next !== "&") {
            return {segments: [], rejectedSyntax: "后台进程"};
        }
        if (char === ";" || char === "\n" || char === "|") {
            push();
            if (char === "|" && next === char) index += 1;
            continue;
        }
        if (char === "&" && next === "&") {
            push();
            index += 1;
            continue;
        }
        current += char;
    }
    if (quote) return {segments: [], rejectedSyntax: "未闭合引号"};
    push();
    return {segments: rawSegments.map(tokenizeSegment)};
}

function tokenizeSegment(segment: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: "single" | "double" | null = null;
    let escaped = false;
    const push = () => {
        if (current) tokens.push(current);
        current = "";
    };
    for (const char of segment) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\" && quote !== "single") {
            escaped = true;
            continue;
        }
        if (char === "'" && quote !== "double") {
            quote = quote === "single" ? null : "single";
            continue;
        }
        if (char === '"' && quote !== "single") {
            quote = quote === "double" ? null : "double";
            continue;
        }
        if (!quote && /\s/.test(char)) {
            push();
            continue;
        }
        current += char;
    }
    push();
    return tokens;
}

function isLocalUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
        );
    } catch {
        return false;
    }
}

function curlWritesToFile(args: string[]): boolean {
    const fileOutputFlags = new Set([
        "-O",
        "--cookie-jar",
        "--dump-header",
        "--output",
        "--output-dir",
        "--remote-header-name",
        "--remote-name",
        "--trace",
        "--trace-ascii",
    ]);
    return args.some(
        (value) =>
            fileOutputFlags.has(value) ||
            value === "-c" ||
            value === "-o" ||
            [...fileOutputFlags].some((flag) => value.startsWith(`${flag}=`))
    );
}

function isCurlReachabilityProbe(args: string[]): boolean {
    const urls = args.filter((value) => /^https?:\/\//i.test(value));
    if (
        curlWritesToFile(args) ||
        urls.length !== 1 ||
        !urls.every(isLocalUrl)
    ) {
        return false;
    }

    const forbiddenFlags = new Set([
        "-K",
        "--config",
        "-d",
        "--data",
        "--data-ascii",
        "--data-binary",
        "--data-raw",
        "--data-urlencode",
        "-F",
        "--form",
        "--form-string",
        "--json",
        "-L",
        "--location",
        "--connect-to",
        "--proxy",
        "--resolve",
        "-T",
        "--upload-file",
        "-x",
    ]);
    if (
        args.some(
            (value) =>
                forbiddenFlags.has(value) ||
                [...forbiddenFlags].some((flag) => value.startsWith(`${flag}=`))
        )
    ) {
        return false;
    }

    const requestIndex = args.findIndex(
        (value) => value === "-X" || value === "--request"
    );
    const inlineRequest = args.find((value) => value.startsWith("--request="));
    const method = requestIndex >= 0
        ? args[requestIndex + 1]
        : inlineRequest?.slice("--request=".length);
    return !method || ["GET", "HEAD"].includes(method.toUpperCase());
}

function isPackageVerification(tokens: string[]): boolean {
    const [command, subcommand, script] = tokens;
    if (!command || !subcommand) return false;
    if (command === "npm" || command === "pnpm" || command === "yarn") {
        if (subcommand === "test") return true;
        return subcommand === "run" && !!script && PACKAGE_SCRIPTS.has(script);
    }
    if (command === "bun") {
        if (subcommand === "test") return true;
        return subcommand === "run" && !!script && PACKAGE_SCRIPTS.has(script);
    }
    return false;
}

function normalizedCommand(tokens: string[]): string | undefined {
    if (tokens[0] === "time") tokens = tokens.slice(1);
    return tokens[0];
}

function countCurlProbes(parsed: ParsedShellCommand): number {
    return parsed.segments.reduce(
        (count, tokens) => count + (normalizedCommand(tokens) === "curl" ? 1 : 0),
        0
    );
}

function isVerificationSegment(tokens: string[], cwd: string): boolean {
    if (tokens[0] === "time") tokens = tokens.slice(1);
    const [command, ...args] = tokens;
    if (!command) return false;
    if (command === "cd") {
        const target = args[0];
        return !!target && resolve(cwd, target) === resolve(cwd);
    }
    if (command === "curl") {
        return isCurlReachabilityProbe(args);
    }
    if (isShellCommandReadOnly(tokens.join(" "))) return true;
    if (command === "python" || command === "python3") {
        return args[0] === "-m" && ["json.tool", "pytest"].includes(args[1] ?? "");
    }
    if (command === "pytest") return true;
    if (command === "node") return args[0] === "--check" && !!args[1];
    if (command === "go") return args[0] === "test";
    if (command === "cargo") return ["check", "clippy", "test"].includes(args[0] ?? "");
    if (command === "make") return ["build", "check", "test", "verify"].includes(args[0] ?? "");
    if (command === "tsc") return args.includes("--noEmit");
    if (command === "sleep") {
        const seconds = Number(args[0]);
        return Number.isFinite(seconds) && seconds >= 0 && seconds <= 5;
    }
    return isPackageVerification(tokens);
}

function checkVerificationShellCommand(
    command: string,
    cwd: string
): PermissionResult {
    const parsed = parseShell(command);
    if (parsed.rejectedSyntax) {
        return {
            behavior: "deny",
            message: `Verification Agent 禁止使用${parsed.rejectedSyntax}；请使用已有后台任务和直接验证命令。`,
        };
    }
    if (
        parsed.segments.length > 0 &&
        parsed.segments.every((tokens) => isVerificationSegment(tokens, cwd))
    ) {
        return {behavior: "allow"};
    }
    return {
        behavior: "deny",
        message:
            "Verification Agent 只允许只读查询、localhost API/HTML GET/HEAD 可达性探测、项目测试/检查命令；禁止用 curl 发送业务数据，也禁止安装依赖、启停进程或执行任意脚本。",
    };
}

export function createVerificationBashTool(): Tool {
    let curlProbesUsed = 0;
    return {
        ...bashTool,
        description:
            "运行受控的项目检查命令。curl 仅用于 localhost API 或 HTML 的 GET/HEAD 可达性探测，每次只能请求一个 URL，整个验证过程最多两次；不得发送业务数据或构造功能测试矩阵。",
        async checkPermissions(
            {
                command,
                sandbox_permissions,
            }: {
                command: string;
                sandbox_permissions?: "use_default" | "require_escalated";
            },
            ctx
        ) {
            if (sandbox_permissions === "require_escalated") {
                return {
                    behavior: "deny",
                    message: "Verification Agent 不允许脱离 OS Sandbox。",
                };
            }
            const permission = checkVerificationShellCommand(command, ctx.cwd);
            if (permission.behavior !== "allow") return permission;

            const curlProbes = countCurlProbes(parseShell(command));
            if (curlProbesUsed + curlProbes > MAX_CURL_PROBES) {
                return {
                    behavior: "deny",
                    message:
                        "Verification Agent 的 localhost curl 可达性探测预算已用尽（最多 2 次）。请使用项目测试或浏览器工具；缺少对应能力时报告 PARTIAL。",
                };
            }
            // 在权限阶段预留预算，避免同一批次中的并发 curl 一起越过上限。
            curlProbesUsed += curlProbes;
            return permission;
        },
    };
}

export const verificationBashTaskTool: Tool = {
    ...bashTaskTool,
    async checkPermissions({action}: { action: "status" | "stop" }) {
        return action === "status"
            ? {behavior: "allow"}
            : {
                behavior: "deny",
                message:
                    "Verification Agent 只能查询父 Agent 的后台任务，不得停止或替换它。",
            };
    },
};
