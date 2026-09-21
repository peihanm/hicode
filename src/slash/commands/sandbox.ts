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
            "When the Sandbox is unavailable, default Bash execution is denied; this session must not be treated as isolated."
        );
        return lines.join("\n");
    }

    const lines = [
        "Bash Sandbox: ready",
        `Platform: ${status.platform}`,
        status.networkMode === "open"
            ? "Network: open (direct access). Filesystem write restrictions remain enforced."
            : "Network: restricted (proxy and domain approvals). Filesystem restrictions remain enforced.",
    ];
    if (status.warnings.length > 0) {
        lines.push("Warnings:", ...status.warnings.map((item) => `- ${item}`));
    }
    return lines.join("\n");
}

export const sandboxCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "sandbox",
    description: "Show Bash OS Sandbox status",
    async execute(args, context) {
        if (args) {
            await context.onEvent({
                type: "assistant_text",
                content: "/sandbox does not accept arguments; restart HiCode after changing Sandbox Settings.",
            });
            return;
        }
        if (context.openSandbox) {context.openSandbox(); return;}
        await context.onEvent({
            type: "assistant_text",
            content: context.ctx.permissionMode === "full-access"
                ? "This session uses Full Access: new commands run on the host under the current OS account."
                : formatSandboxStatus(context.ctx.shellRunner.sandboxStatus),
        });
    },
};
