import type {SlashCommand} from "../types.js";

export const modelCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "model",
    description: "查看或切换当前主模型",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法：/model",
            });
            return;
        }
        if (context.openModel) {
            context.openModel();
            return;
        }
        await context.onEvent({
            type: "assistant_text",
            content: `当前主模型：${context.ctx.model}`,
        });
    },
};
