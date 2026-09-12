import type {SlashCommand} from "../types.js";

export const hooksCommand: SlashCommand = {
    name: "hooks", description: "View Hook configuration, approvals and recent runs; reload when idle", argumentHint: "[reload]", busyBehavior: "immediate",
    async execute(args, {ctx, onEvent}) {
        let content: string;
        if (!ctx.hookControl) content = "This Runtime has no Hook management capability.";
        else if (args && args !== "reload") content = "Usage: /hooks [reload]";
        else {
            try {
                if (args === "reload") await ctx.hookControl.reload(ctx.signal);
                const definitions = ctx.hookControl.inspect();
                const lines = definitions.map(item => {
                    const origin = item.source === "host" ? `host:${item.id}` : `${item.source}:${item.path}`;
                    const handler = item.command ?? (item.executable ? JSON.stringify([item.executable, ...(item.args ?? [])]) : `prompt: ${item.prompt}`);
                    return `- ${item.event} · ${item.purpose} · ${item.approved ? "approved" : "disabled"} · ${item.hookId.slice(0, 12)}\n` +
                        `  ${origin}\n  ${handler?.slice(0, 300)}\n` +
                        `  matcher=${item.matcher ?? "*"}${item.condition ? ` · if=${item.condition}` : ""}` +
                        ` · once=${item.once ? ctx.hookSession?.wasClaimed(item.hookId) ? "consumed" : "ready" : "off"}` +
                        ` · handler≤${item.timeoutMs}ms / dispatch≤${item.dispatchTimeoutMs}ms`;
                });
                const recent = ctx.hookSession?.recent().slice(-20) ?? [];
                content = `${args === "reload" ? "Hooks reloaded.\n" : ""}${lines.join("\n") || "No Hooks configured."}`;
                if (recent.length) content += "\n\nRecent runs:\n" + recent.map(item =>
                    `- ${item.startedAt} · ${item.event} · ${item.outcome} · ${Math.round(item.durationMs ?? 0)}ms` +
                    `${item.userMessage || item.message ? `\n  ${item.userMessage ?? item.message}` : ""}` +
                    `${item.artifact ? `\n  ${item.artifact.path}` : ""}`).join("\n");
                content += "\n\nApproval binds Hook definitions, not the contents of referenced scripts; once is consumed after a match, before execution is attempted.";
            } catch (error) {content = `Hook operation failed (previous configuration preserved): ${error instanceof Error ? error.message : String(error)}`;}
        }
        await onEvent({type: "assistant_text", content});
    },
};
