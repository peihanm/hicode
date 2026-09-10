import type {SlashCommand} from "../types.js";
import type {CollaborationMode} from "../../collaboration/index.js";

function modeCommand(mode: CollaborationMode): SlashCommand {
    return {
        name: mode,
        description: mode === "plan" ? "先探索并讨论方案" : "按当前权限开始实现",
        busyBehavior: "immediate",
        async execute(args, context) {
            if (args.trim()) {
                await context.onEvent({type: "assistant_text", content: `用法：/${mode}`});
                return;
            }
            if (!context.setCollaborationMode) {
                await context.onEvent({type: "assistant_text", content: "请通过 Host 的 collaborationMode 参数切换工作方式"});
                return;
            }
            context.setCollaborationMode(mode);
            await context.onEvent({type: "assistant_text", content: mode === "plan"
                ? "已切换到 Plan：先探索和整理方案。" : "已切换到 Build：按当前权限执行任务。"});
        },
    };
}

export const planCommand = modeCommand("plan");
export const buildCommand = modeCommand("build");
