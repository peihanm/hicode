import type {SlashCommand} from "../types.js";

export const resumeCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "resume",
    description: "选择并恢复当前项目的历史会话",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法：/resume",
            });
            return;
        }
        if (!context.openResume) {
            await context.onEvent({
                type: "assistant_text",
                content: "当前宿主不支持交互式 /resume。",
            });
            return;
        }
        context.openResume();
    },
};
