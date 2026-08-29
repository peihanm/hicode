import type {SandboxStatus} from "../../sandbox/index.js";
import type {SlashCommand} from "../types.js";

export function formatSandboxStatus(status: SandboxStatus): string {
    if (status.kind === "disabled") {
        return [
            "Bash Sandbox: disabled",
            "可在 Settings 中配置 sandbox.enabled=true，修改后重启 Pillar。",
        ].join("\n");
    }
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
    kind: "local",
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
            content: formatSandboxStatus(context.ctx.shellRunner.sandboxStatus),
        });
    },
};
