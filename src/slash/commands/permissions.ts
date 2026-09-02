import {getPermissionModeDescription} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

export const permissionsCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "permissions",
    description: "查看或切换权限 Profile",
    async execute(args, context) {
        if (args.trim()) {
            await context.onEvent({
                type: "assistant_text",
                content: "用法：/permissions",
            });
            return;
        }
        if (context.openPermissions) {
            context.openPermissions();
            return;
        }
        await context.onEvent({
            type: "assistant_text",
            content: [
                `当前权限：${context.ctx.permissionMode}`,
                getPermissionModeDescription(context.ctx.permissionMode),
            ].join("\n"),
        });
    },
};
