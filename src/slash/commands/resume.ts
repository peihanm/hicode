import type {SlashCommand} from "../types.js";

export const resumeCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "resume",
    description: "Select and resume a previous session in this project",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "Usage: /resume",
            });
            return;
        }
        if (!context.openResume) {
            await context.onEvent({
                type: "assistant_text",
                content: "This Host does not support interactive /resume.",
            });
            return;
        }
        context.openResume();
    },
};
