import type {SlashCommand} from "../types.js";

export const commitCommand: SlashCommand = {
    kind: "prompt",
    name: "commit",
    description: "审查当前变化并创建本地 Git Commit",
    argumentHint: "[补充要求]",
    async execute(args) {
        const extra = args
            ? `\n用户对本次 Commit 的补充要求：\n${args}`
            : "";
        return {
            kind: "prompt",
            allowedTools: [
                "bash",
                "read_tool_result",
            ],
            prompt: [
                "用户明确请求创建一个本地 Git Commit。请只使用 Bash 完成标准 Git Commit 工作流。",
                "先运行 git status --short、git diff、git diff --cached 和 git log -5 --oneline，理解 staged/unstaged/untracked、真实改动与最近 Commit 风格。可并行执行彼此独立的只读查询。",
                "只选择用户明确要求范围内且不像 Secret/凭据的文件。不要根据当前会话观察过某个文件，就假定整份文件都属于 Pillar。",
                "如果 Index 已有本次范围之外的 Staged 变化，停止并向用户说明；不要 Unstage、Reset、Restore、Stash 或扩大范围。",
                "生成关注 Why、符合最近历史风格的 Commit Message。使用 git add -- <精确路径...> Stage 枚举后的文件，再运行 git commit -m <message>；不得使用 git add .、git add -A 或未经枚举的目录级 Pathspec。",
                "不得 Amend、Push、Force Push、创建 PR、跳过 Hook、修改 Git Config、自动 Stash/Reset/Clean，或在 Merge/Rebase/Cherry-pick/Revert/冲突状态下擅自 Commit。",
                "Commit 后运行 git status --short 和 git log -1 --oneline，依据真实退出码与最终仓库状态报告结果。Hook 或签名失败时如实说明，不要规避后重试。",
                "若没有安全可提交的路径、状态有冲突，或权限被拒绝，准确说明原因并停止。",
                extra,
            ].filter(Boolean).join("\n"),
        };
    },
};
