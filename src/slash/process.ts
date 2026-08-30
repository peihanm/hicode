import {findSlashCommand, getSlashCommands} from "./registry.js";
import type {CompactHistoryRunner, ToolSchemaProvider,} from "../agent/invokePreparation.js";
import type {SlashCommandHostContext, SlashCommandProcessor,} from "./types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import type {MemoryRuntimeLike} from "../memory/index.js";
import type {AgentEvent} from "../agent/types.js";

const MAX_SLASH_INPUT_CHARS = 1024 * 1024;
const MAX_SLASH_TEXT_CHARS = 100_000;

function limitSlashEvent(event: AgentEvent): AgentEvent {
    if (
        event.type !== "assistant_text" ||
        event.content.length <= MAX_SLASH_TEXT_CHARS
    ) return event;
    return {
        ...event,
        content:
            `${event.content.slice(0, MAX_SLASH_TEXT_CHARS)}\n\n` +
            "[Slash output truncated at 100,000 characters]",
    };
}

function parseSlashInput(input: string): { name: string; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const match = trimmed.match(/^\/([A-Za-z0-9:_-]+|\?)(?:\s+([\s\S]*))?$/);
    if (!match) return null;

    return {
        name: match[1] || "",
        args: match[2]?.trim() || "",
    };
}

function formatHelp(): string {
    const commands = [
        "/help - 显示可用命令",
        ...getSlashCommands().map((cmd) => {
            const args = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
            return `/${cmd.name}${args} - ${cmd.description}`;
        }),
    ]
        .join("\n");

    return `可用命令:\n${commands}`;
}

interface SlashCommandProcessorDependencies {
    compactHistory: CompactHistoryRunner;
    getToolSchemas: ToolSchemaProvider;
    subagents: SubagentRegistry;
    memory?: MemoryRuntimeLike;
}

export function createSlashCommandProcessor({
    compactHistory: compactHistoryImpl,
    getToolSchemas: getToolSchemasImpl,
    subagents,
    memory,
}: SlashCommandProcessorDependencies): SlashCommandProcessor {
    const process = async function processConfiguredSlashCommand(
        input: string,
        context: SlashCommandHostContext
    ): Promise<boolean> {
        if (input.length > MAX_SLASH_INPUT_CHARS) {
            if (!input.trimStart().startsWith("/")) return false;
            await context.onEvent({
                type: "assistant_text",
                content: "Slash 命令超过 1,048,576 字符上限。",
            });
            return true;
        }
        const parsed = parseSlashInput(input);
        if (!parsed) {
            if (input.trim() !== "/") {
                return false;
            }
            await context.onEvent({
                type: "assistant_text",
                content: "命令格式应为 `/command [args]`。",
            });
            return true;
        }

        if (parsed.name === "help" || parsed.name === "?") {
            await context.onEvent({
                type: "assistant_text",
                content: parsed.args ? "用法: /help" : formatHelp(),
            });
            return true;
        }

        const command = findSlashCommand(parsed.name);
        if (!command) {
            await context.onEvent({
                type: "assistant_text",
                content: `未知命令: /${parsed.name}。输入 /help 查看可用命令。`,
            });
            return true;
        }

        await command.execute(parsed.args, {
            ...context,
            onEvent: (event) => context.onEvent(limitSlashEvent(event)),
            compactHistory: compactHistoryImpl,
            getToolSchemas: getToolSchemasImpl,
            subagents,
            memory,
        });
        return true;
    };

    return {
        process,
        getBusyBehavior(input) {
            const parsed = parseSlashInput(input);
            if (!parsed) return "defer";
            if (parsed.name === "help" || parsed.name === "?") {
                return "immediate";
            }
            const command = findSlashCommand(parsed.name);
            return command?.busyBehavior ?? "defer";
        },
    };
}
