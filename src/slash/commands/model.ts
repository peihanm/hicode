import type {SlashCommand} from "../types.js";

export const modelCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "model",
    description: "View or switch the main model",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "Usage: /model",
            });
            return;
        }
        if (context.openModel) {
            context.openModel();
            return;
        }
        await context.onEvent({
            type: "assistant_text",
            content: `Current main model: ${context.ctx.model}`,
        });
    },
};
