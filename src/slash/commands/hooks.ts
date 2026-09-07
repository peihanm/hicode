import type {SlashCommand} from "../types.js";

export const hooksCommand: SlashCommand = {
    name: "hooks", description: "查看 Hook 配置、批准与最近执行；空闲时重载", argumentHint: "[reload]", busyBehavior: "immediate",
    async execute(args, {ctx, onEvent}) {
        let content: string;
        if (!ctx.hookControl) content = "当前 Runtime 不提供 Hook 管理能力。";
        else if (args && args !== "reload") content = "用法: /hooks [reload]";
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
                content = `${args === "reload" ? "Hooks 已重载。\n" : ""}${lines.join("\n") || "当前没有配置 Hook。"}`;
                if (recent.length) content += "\n\n最近执行：\n" + recent.map(item =>
                    `- ${item.startedAt} · ${item.event} · ${item.outcome} · ${Math.round(item.durationMs ?? 0)}ms` +
                    `${item.userMessage || item.message ? `\n  ${item.userMessage ?? item.message}` : ""}` +
                    `${item.artifact ? `\n  ${item.artifact.path}` : ""}`).join("\n");
                content += "\n\n批准绑定 Hook 定义，不追踪命令引用脚本的正文；once 在真正匹配后尝试执行前消耗。";
            } catch (error) {content = `Hooks 操作失败（原配置保留）：${error instanceof Error ? error.message : String(error)}`;}
        }
        await onEvent({type: "assistant_text", content});
    },
};
