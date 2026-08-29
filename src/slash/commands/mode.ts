import {getPermissionModeDescription, listPermissionModes, parsePermissionMode,} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

function formatModes(currentMode: string): string {
    const lines = listPermissionModes().map((mode) => {
        const marker = mode === currentMode ? "*" : " ";
        return `${marker} ${mode.padEnd(18)} ${getPermissionModeDescription(mode)}`;
    });
    return `当前权限模式: ${currentMode}\n\n可用模式:\n${lines.join("\n")}`;
}

export const modeCommand: SlashCommand = {
    kind: "local",
    busyBehavior: "immediate",
    name: "mode",
    description: "查看或切换当前权限模式",
    argumentHint: "[default|acceptEdits|plan|bypassPermissions|dontAsk]",
    async execute(args, context) {
        if (!args.trim()) {
            await context.onEvent({
                type: "assistant_text",
                content: formatModes(context.ctx.permissionMode),
            });
            return;
        }

        const mode = parsePermissionMode(args);
        if (!mode) {
            await context.onEvent({
                type: "assistant_text",
                content:
                    `未知权限模式: ${args}\n` +
                    "可用模式: default, acceptEdits, plan, bypassPermissions, dontAsk",
            });
            return;
        }

        context.ctx.setPermissionMode(mode);
    },
};
