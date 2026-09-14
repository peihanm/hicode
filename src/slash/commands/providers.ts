import type {SlashCommand} from "../types.js";

export const providersCommand: SlashCommand = {
    name: "providers",
    description: "Configure provider credentials, API endpoints and model lists",
    busyBehavior: "defer",
    async execute(args, context) {
        if (!args && context.openProviders) {context.openProviders(); return;}
        await context.onEvent({type: "assistant_text", content: args ? "Usage: /providers" : "Provider setup is available in the interactive CLI. Configure credentials through the Host in SDK/headless mode."});
    },
};
