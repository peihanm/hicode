import {findSlashCommand, getSlashCommands} from "./registry.js";
import type {CompactHistoryRunner, ToolSchemaProvider,} from "../agent/invokePreparation.js";
import type {SlashCommandHostContext, SlashCommandProcessResult, SlashCommandProcessor,} from "./types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import type {MemoryRuntimeLike} from "../memory/index.js";

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
    ): Promise<SlashCommandProcessResult> {
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
                content: formatHelp(),
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

        const result = await command.execute(parsed.args, {
            ...context,
            compactHistory: compactHistoryImpl,
            getToolSchemas: getToolSchemasImpl,
            subagents,
            memory,
        });
        return result ?? true;
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
            return command?.kind === "local"
                ? command.busyBehavior
                : "defer";
        },
    };
}
