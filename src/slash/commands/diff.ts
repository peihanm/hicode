import type {SlashCommand} from "../types.js";

export const diffCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "diff",
    description: "View current uncommitted Git changes",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "Usage: /diff",
            });
            return;
        }
        if (!context.openGitDiff) {
            await context.onEvent({
                type: "assistant_text",
                content: "This Host does not support interactive /diff. Use the interactive TUI or run read-only git diff through Bash.",
            });
            return;
        }
        context.openGitDiff();
    },
};
