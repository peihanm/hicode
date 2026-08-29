// 环境信息探测
// 参考 claude-code src/context.ts:36-111 的 getGitStatus
//
// 运行时探测环境信息（cwd/platform/shell/git/date），供 system prompt 拼接。
// 用 execSync 同步执行——gitStatus 是 snapshot（启动时跑一次，会话内不更新），
// 对齐 claude-code 的 memoize snapshot 策略。
// git 命令失败不致命（返回 isGit: false）
//
// LLM 需要最新状态或差异时，通过 Bash 运行只读 Git 命令。

import {execSync} from "node:child_process";
import {release, type} from "node:os";

export interface EnvInfo {
    cwd: string;
    platform: string; // os.type() + os.release()
    shell: string; // process.env.SHELL
    isGit: boolean;
    gitStatus?: string; // claude-code 风格的 5 字段格式 + snapshot 提示语
    model: string;
}

// 安全执行 shell 命令，失败返回空字符串
function safeExec(cmd: string, cwd: string): string {
    try {
        return execSync(cmd, {
            cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"], // stderr 丢弃
            timeout: 3000, // git 命令最多等 3s
        }).trim();
    } catch {
        return "";
    }
}

// 检测是否 git 仓库
function checkIsGit(cwd: string): boolean {
    const out = safeExec("git rev-parse --is-inside-work-tree", cwd);
    return out === "true";
}

// 获取当前分支名
function getBranch(cwd: string): string {
    return safeExec("git branch --show-current", cwd);
}

// 获取默认分支（origin/HEAD → main → master）
function getDefaultBranch(cwd: string): string {
    const remote = safeExec("git rev-parse --abbrev-ref origin/HEAD", cwd);
    if (remote.startsWith("origin/")) return remote.slice(7);
    const mainExists = safeExec("git rev-parse --verify main", cwd);
    if (mainExists) return "main";
    return "master";
}

// 获取 git 用户名
function getGitUserName(cwd: string): string {
    return safeExec("git config user.name", cwd);
}

// 获取 git 状态摘要
// 对齐 claude-code context.ts:96-103 的格式：
// - snapshot 提示语（会话内不更新）
// - Current branch / Main branch / Git user / Status / Recent commits 5 字段
// - Status 超 2000 字符截断
function getGitStatus(cwd: string): string | undefined {
    const branch = getBranch(cwd);
    const mainBranch = getDefaultBranch(cwd);
    const status = safeExec("git status --short", cwd);
    const log = safeExec("git log --oneline -n 5", cwd);
    const userName = getGitUserName(cwd);

    const MAX_STATUS_CHARS = 2000;
    const truncatedStatus =
        status.length > MAX_STATUS_CHARS
            ? status.substring(0, MAX_STATUS_CHARS) +
            '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using Bash)'
            : status;

    const parts: string[] = [
        "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
        `Current branch: ${branch}`,
        `Main branch (you will usually use this for PRs): ${mainBranch}`,
        ...(userName ? [`Git user: ${userName}`] : []),
        `Status:\n${truncatedStatus || "(clean)"}`,
        `Recent commits:\n${log}`,
    ];
    return parts.join("\n\n");
}

// 探测环境信息（sync snapshot，启动时跑一次）
export function detectEnv(cwd: string, model: string): EnvInfo {
    const isGit = checkIsGit(cwd);
    const gitStatus = isGit ? getGitStatus(cwd) : undefined;

    return {
        cwd,
        platform: `${type()} ${release()}`,
        shell: process.env.SHELL ?? "unknown",
        isGit,
        gitStatus,
        model,
    };
}
