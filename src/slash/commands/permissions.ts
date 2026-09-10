import {getPermissionModeDescription, getPermissionModeShortLabel} from "../../permissions/index.js";
import type {SlashCommand} from "../types.js";

export const permissionsCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "permissions",
    description: "选择哪些操作需要确认",
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
                `操作审批：${getPermissionModeShortLabel(context.ctx.permissionMode)}`,
                getPermissionModeDescription(context.ctx.permissionMode),
            ].join("\n"),
        });
    },
};
