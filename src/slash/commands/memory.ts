import {MEMORY_TYPES, type MemoryType} from "../../memory/index.js";
import type {SlashCommand} from "../types.js";

function isMemoryType(value: string): value is MemoryType {
    return (MEMORY_TYPES as readonly string[]).includes(value);
}

export const memoryCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "memory",
    description: "View and maintain persistent Memory across Sessions",
    argumentHint: "[list [type] | show <key> | forget <key> | maintain]",
    async execute(args, context) {
        const memory = context.memory;
        if (!memory) {
            await context.onEvent({
                type: "assistant_text",
                content: "This Runtime has no Memory capability.",
            });
            return;
        }
        const [action = "status", value, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (rest.length > 0) {
            await context.onEvent({
                type: "assistant_text",
                content: "Usage: /memory [list [type] | show <key> | forget <key> | maintain]",
            });
            return;
        }

        if (action === "status") {
            const status = await memory.status();
            const lines = [
                `Memory: ${status.enabled ? "enabled" : "disabled"}`,
                `Auto extract: ${status.autoExtract ? "enabled" : "disabled"}`,
                `Directory: ${status.directory}`,
                `Entries: user ${status.counts.user} · feedback ${status.counts.feedback} · project ${status.counts.project} · reference ${status.counts.reference}`,
                `Pending notes: ${status.pending} · Published topics: ${status.published} · Maintaining: ${status.maintaining ? "yes" : "no"}`,
            ];
            if (status.issues.length > 0) {
                lines.push(
                    "Issues:",
                    ...status.issues.slice(-10).map((issue) =>
                        `- ${issue.path}: ${issue.message}`
                    )
                );
            }
            if (!status.enabled) {
                lines.push("Configure memory.enabled in Settings, then restart Pillar.");
            }
            await context.onEvent({type: "assistant_text", content: lines.join("\n")});
            return;
        }

        if (!memory.enabled) {
            await context.onEvent({
                type: "assistant_text",
                content: "Memory is disabled. Enable it in Settings and restart Pillar.",
            });
            return;
        }

        if (action === "list") {
            if (value && !isMemoryType(value)) {
                await context.onEvent({
                    type: "assistant_text",
                    content: `Unknown Memory type: ${value}. Available: ${MEMORY_TYPES.join(", ")}`,
                });
                return;
            }
            const scan = await memory.list();
            const entries = value
                ? scan.entries.filter((entry) => entry.type === value)
                : scan.entries;
            const lines = entries.map((entry) =>
                `- ${entry.key} [${entry.type}] ${entry.name} — ${entry.description}`
            );
            await context.onEvent({
                type: "assistant_text",
                content: lines.length > 0 ? lines.join("\n") : "No persistent Memory.",
            });
            return;
        }

        if (action === "show") {
            if (!value) {
                await context.onEvent({type: "assistant_text", content: "Usage: /memory show <key>"});
                return;
            }
            const entry = await memory.read(value);
            await context.onEvent({
                type: "assistant_text",
                content: entry
                    ? `# ${entry.name}\n\n${entry.description}\n\n${entry.content}\n\nSources: ${JSON.stringify(entry.evidence)}\n\nPath: ${entry.path}`
                    : `Memory not found: ${value}`,
            });
            return;
        }

        if (action === "forget") {
            if (!value) {
                await context.onEvent({type: "assistant_text", content: "Usage: /memory forget <key>"});
                return;
            }
            if (context.ctx.readOnlyTools || context.ctx.collaborationMode === "plan") {
                await context.onEvent({type: "assistant_text", content: "Cannot delete Memory in read-only/Plan mode."}); return;
            }
            const change = await memory.forget(value, context.ctx.signal);
            if (change) {
                await context.onEvent({
                    type: "memory_update",
                    source: "explicit",
                    changes: [change],
                });
                await context.onEvent({
                    type: "assistant_text",
                    content: `Memory forgotten: ${change.key}`,
                });
            } else {
                await context.onEvent({
                    type: "assistant_text",
                    content: `Memory not found: ${value}`,
                });
            }
            return;
        }

        if (action === "maintain") {
            if (context.ctx.readOnlyTools || context.ctx.collaborationMode === "plan") {
                await context.onEvent({type: "assistant_text", content: "Cannot consolidate Memory in read-only/Plan mode."}); return;
            }
            if(!context.ctx.tasks) {await context.onEvent({type:"assistant_text",content:"This Runtime has no Memory maintenance task capability."});return;}
            const task=await context.ctx.tasks.startMemory({turnId:context.ctx.turnId,signal:context.ctx.signal,background:false});
            await context.onEvent({type:"assistant_text",content:task?task.resultPreview??task.outputIssue??`Memory task ${task.status}`:"No pending sources, or consolidation is already running; no new model call was started."});
            return;
        }

        await context.onEvent({
            type: "assistant_text",
            content: "Usage: /memory [list [type] | show <key> | forget <key> | maintain]",
        });
    },
};
