import type {SlashCommand} from "../types.js";

export const diffCommand: SlashCommand = {
    kind: "local",
    busyBehavior: "defer",
    name: "diff",
    description: "交互查看当前修改与历史任务差异",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法: /diff",
            });
            return;
        }
        if (!context.openGitDiff) {
            await context.onEvent({
                type: "assistant_text",
                content: "当前宿主不支持交互式 /diff。请在交互式 TUI 中使用，或通过 Bash 运行只读的 git diff。",
            });
            return;
        }
        context.openGitDiff();
    },
};
