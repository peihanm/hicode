import type {SandboxStatus} from "../../sandbox/index.js";
import type {SlashCommand} from "../types.js";

export function formatSandboxStatus(status: SandboxStatus): string {
    if (status.kind === "unavailable") {
        const lines = [
            "Bash Sandbox: unavailable",
            `Reason: ${status.reason}`,
        ];
        if (status.warnings.length > 0) {
            lines.push("Warnings:", ...status.warnings.map((item) => `- ${item}`));
        }
        lines.push(
            "Sandbox 不可用时，默认 Bash 会拒绝执行；不要把当前会话理解为已隔离。"
        );
        return lines.join("\n");
    }

    const lines = [
        "Bash Sandbox: ready",
        `Platform: ${status.platform}`,
        "文件与网络边界由 OS 强制执行；权限系统仍独立生效。",
    ];
    if (status.warnings.length > 0) {
        lines.push("Warnings:", ...status.warnings.map((item) => `- ${item}`));
    }
    return lines.join("\n");
}

export const sandboxCommand: SlashCommand = {
    busyBehavior: "immediate",
    name: "sandbox",
    description: "显示 Bash OS Sandbox 状态",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "/sandbox 暂不接受参数；修改 Sandbox Settings 后请重启 Pillar。",
            });
            return;
        }
        await context.onEvent({
            type: "assistant_text",
            content: context.ctx.permissionMode === "full-access"
                ? "当前会话为 Full Access：新命令在宿主环境执行，受当前系统账户权限约束。"
                : formatSandboxStatus(context.ctx.shellRunner.sandboxStatus),
        });
    },
};
