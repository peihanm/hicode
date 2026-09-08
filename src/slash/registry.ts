import {hooksCommand} from "./commands/hooks.js";
import {compactCommand} from "./commands/compact.js";
import {permissionsCommand} from "./commands/permissions.js";
import {mcpCommand} from "./commands/mcp.js";
import {agentsCommand} from "./commands/agents.js";
import {memoryCommand} from "./commands/memory.js";
import {rewindCommand} from "./commands/rewind.js";
import {sandboxCommand} from "./commands/sandbox.js";
import {tasksCommand} from "./commands/tasks.js";
import {diffCommand} from "./commands/diff.js";
import {modelCommand} from "./commands/model.js";
import {resumeCommand} from "./commands/resume.js";
import {addDirCommand} from "./commands/addDir.js";
import type {SlashCommand} from "./types.js";

const COMMANDS: readonly SlashCommand[] = [
    hooksCommand,
    compactCommand,
    modelCommand,
    resumeCommand,
    permissionsCommand,
    addDirCommand,
    mcpCommand,
    agentsCommand,
    memoryCommand,
    rewindCommand,
    diffCommand,
    sandboxCommand,
    tasksCommand,
];

export interface SlashCommandSuggestion {
    name: string;
    description: string;
    argumentHint?: string;
}

const BUILTIN_SUGGESTIONS: readonly SlashCommandSuggestion[] = [
    {
        name: "help",
        description: "显示可用命令",
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
        // Attachment commands are consumed by the TUI controller before Slash execution.
        {name: "attach", description: "添加本地图片附件", argumentHint: "<路径>"},
        {name: "paste-image", description: "添加本机 macOS 剪贴板图片"},
        {name: "attachments", description: "查看图片附件"},
        {name: "detach", description: "移除图片附件", argumentHint: "<编号|all>"},
    ];

    return commands.filter((cmd) => cmd.name.toLowerCase().startsWith(query));
}

export function findSlashCommand(name: string): SlashCommand | undefined {
    return COMMANDS.find(
        (cmd) => cmd.name === name || cmd.aliases?.includes(name)
    );
}
