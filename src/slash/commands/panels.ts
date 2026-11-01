import {getPermissionModeDescription, getPermissionModeShortLabel} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

type PanelContext = Parameters<SlashCommand["execute"]>[1];

function panelCommand(options: {
    name: string;
    description: string;
    open: "openModel" | "openProviders" | "openPermissions" | "openResume" | "openGitDiff";
    fallback: (context: PanelContext) => string;
}): SlashCommand {
    return {
        name: options.name,
        description: options.description,
        busyBehavior: "defer",
        async execute(args, context) {
            if (args.trim()) {
                await context.onEvent({type: "assistant_text", content: `Usage: /${options.name}`});
                return;
            }
            const open = context[options.open];
            if (open) {
                open();
                return;
            }
            await context.onEvent({type: "assistant_text", content: options.fallback(context)});
        },
    };
}

export const modelCommand = panelCommand({
    name: "model",
    description: "View or switch the model",
    open: "openModel",
    fallback: ({ctx}) => `Current model: ${ctx.model}`,
});

export const providersCommand = panelCommand({
    name: "providers",
    description: "Configure provider credentials, API endpoints and model lists",
    open: "openProviders",
    fallback: () => "Provider setup is available in the interactive CLI. Configure credentials through the Host in SDK/headless mode.",
});

export const permissionsCommand = panelCommand({
    name: "permissions",
    description: "Choose who approves extra access",
    open: "openPermissions",
    fallback: ({ctx}) => [
        `Access & approval: ${getPermissionModeShortLabel(ctx.permissionMode)}`,
        getPermissionModeDescription(ctx.permissionMode),
    ].join("\n"),
});

export const resumeCommand = panelCommand({
    name: "resume",
    description: "Select and resume a previous session in this project",
    open: "openResume",
    fallback: () => "This Host does not support interactive /resume.",
});

export const diffCommand = panelCommand({
    name: "diff",
    description: "View current uncommitted Git changes",
    open: "openGitDiff",
    fallback: () => "This Host does not support interactive /diff. Use the interactive TUI or run read-only git diff through Bash.",
});
