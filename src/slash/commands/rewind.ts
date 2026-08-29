import type {SlashCommand} from "../types.js";

export const rewindCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "rewind",
    aliases: ["checkpoint"],
    description: "恢复到历史问题之前的代码和/或对话",
    async execute(_args, context) {
        if (!context.openRewind) {
            await context.onEvent({
                type: "assistant_text",
                content: "当前宿主不支持交互式 /rewind。",
            });
            return;
        }
        context.openRewind();
    },
};
