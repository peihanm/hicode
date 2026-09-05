import {resolve} from "node:path";
import type {PermissionResult} from "../../../permissions/index.js";
import {isShellCommandReadOnly, isShellArgvReadOnly, parseShellCommand} from "../../../permissions/shellCommand.js";
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
    const parsed = parseShellCommand(command);
    return parsed.literal
        ? {segments: parsed.segments.map(segment => segment.tokens)}
        : {segments: [], rejectedSyntax: "动态展开、重定向或无法静态解析的 Shell 语法"};
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

function isCurlReachabilityProbe(args: string[]): boolean {
    let urls = 0;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (isLocalUrl(arg)) { urls++; continue; }
        if (/^-[qfsSIi]+$/.test(arg) || ["--disable", "--fail", "--silent", "--show-error", "--head", "--include"].includes(arg)) continue;
        const [option, inlineValue] = arg.split("=", 2);
        if (["--max-time", "--connect-timeout", "-m"].includes(option!)) {
            const value = inlineValue ?? args[++index];
            if (!value || !Number.isFinite(Number(value)) || Number(value) <= 0) return false;
            continue;
        }
        if (["-X", "--request"].includes(option!)) {
            const method = inlineValue ?? args[++index];
            if (method !== "GET" && method !== "HEAD") return false;
            continue;
        }
        return false;
    }
    return urls === 1;
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

function countCurlProbes(parsed: ParsedShellCommand): number {
    return parsed.segments.reduce(
        (count, tokens) => count + (tokens[0] === "curl" ? 1 : 0),
        0
    );
}

function isVerificationSegment(tokens: string[], cwd: string): boolean {
    const [command, ...args] = tokens;
    if (!command) return false;
    if (command === "cd") {
        const target = args[0];
        return !!target && resolve(cwd, target) === resolve(cwd);
    }
    if (command === "curl") {
        return isCurlReachabilityProbe(args);
    }
    if (isShellArgvReadOnly(tokens)) return true;
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
        isReadOnly: ({command, sandbox_permissions}) =>
            sandbox_permissions !== "require_escalated" &&
            checkVerificationShellCommand(command, ".").behavior === "allow",
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
            if (ctx.collaborationMode === "plan" && !isShellCommandReadOnly(command)) {
                return {behavior: "deny", message: "父会话处于 Plan；Verification 不能扩大 Shell 写能力。"};
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
