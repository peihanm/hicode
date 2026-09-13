import type {SlashCommand} from "../types.js";

export const modelCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "model",
    description: "View or switch the model",
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
            content: `Current model: ${context.ctx.model}`,
        });
    },
};
