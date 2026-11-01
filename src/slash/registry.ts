import {modelCommand, providersCommand, permissionsCommand, resumeCommand, diffCommand} from "./commands/panels.js";
import {hooksCommand} from "./commands/hooks.js";
import {compactCommand} from "./commands/compact.js";
import {mcpCommand} from "./commands/mcp.js";
import {skillsCommand} from "./commands/skills.js";
import {agentsCommand} from "./commands/agents.js";
import {memoryCommand} from "./commands/memory.js";
import {sandboxCommand} from "./commands/sandbox.js";
import {tasksCommand} from "./commands/tasks.js";
import {addDirCommand} from "./commands/addDir.js";
import type {SlashCommand} from "./types.js";

const COMMANDS: readonly SlashCommand[] = [
    hooksCommand,
    compactCommand,
    modelCommand,
    providersCommand,
    resumeCommand,
    permissionsCommand,
    addDirCommand,
    mcpCommand,
    skillsCommand,
    agentsCommand,
    memoryCommand,
    diffCommand,
    sandboxCommand,
    tasksCommand,
];

interface SlashCommandSuggestion {
    name: string;
    description: string;
    argumentHint?: string;
}

const BUILTIN_SUGGESTIONS: readonly SlashCommandSuggestion[] = [
    {
        name: "help",
        description: "Show available commands",
    },
];

export function getSlashCommands(): readonly SlashCommand[] {
    return COMMANDS;
}

export function getSlashCommandSuggestions(input: string): SlashCommandSuggestion[] {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return [];
    if (/\s/.test(trimmed.slice(1))) return [];

    const query = trimmed.slice(1).toLowerCase();
    const commands: SlashCommandSuggestion[] = [
        ...BUILTIN_SUGGESTIONS,
        ...COMMANDS.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            argumentHint: cmd.argumentHint,
        })),
    ];

    return commands.filter((cmd) => cmd.name.toLowerCase().startsWith(query));
}

export function findSlashCommand(name: string): SlashCommand | undefined {
    return COMMANDS.find(
        (cmd) => cmd.name === name
    );
}
