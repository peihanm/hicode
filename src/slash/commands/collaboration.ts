import type {SlashCommand} from "../types.js";
import type {CollaborationMode} from "../../collaboration/index.js";

function modeCommand(mode: CollaborationMode): SlashCommand {
    return {
        name: mode,
        description: mode === "plan" ? "Explore and discuss a plan first" : "Implement using the current permissions",
        busyBehavior: "immediate",
        async execute(args, context) {
            if (args.trim()) {
                await context.onEvent({type: "assistant_text", content: `Usage: /${mode}`});
                return;
            }
            if (!context.setCollaborationMode) {
                await context.onEvent({type: "assistant_text", content: "Use the Host collaborationMode parameter to switch work modes"});
                return;
            }
            context.setCollaborationMode(mode);
            await context.onEvent({type: "assistant_text", content: mode === "plan"
                ? "Switched to Plan: explore and develop a plan first." : "Switched to Build: execute using the current permissions."});
        },
    };
}

export const planCommand = modeCommand("plan");
export const buildCommand = modeCommand("build");
