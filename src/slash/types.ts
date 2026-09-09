import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import type {CompactHistoryRunner, ToolSchemaProvider,} from "../agent/invokePreparation.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import type {MemoryRuntimeLike} from "../memory/index.js";

interface SlashCommandContext {
    history: Message[];
    ctx: ToolContext;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    compactHistory: CompactHistoryRunner;
    getToolSchemas: ToolSchemaProvider;
    subagents: SubagentRegistry;
    memory?: MemoryRuntimeLike;
    openResume?: () => void;
    openAgents?: () => void;
    openTasks?: () => void;
    openGitDiff?: () => void;
    openModel?: () => void;
    openPermissions?: () => void;
}

export type SlashCommandHostContext = Omit<
    SlashCommandContext,
    "compactHistory" | "getToolSchemas" | "subagents" | "memory"
>;

export interface SlashCommand {
    name: string;
    aliases?: string[];
    description: string;
    argumentHint?: string;
    busyBehavior: "defer" | "immediate";

    execute(
        args: string,
        context: SlashCommandContext
    ): Promise<void>;
}

export type SlashCommandBusyBehavior = "defer" | "immediate";

export interface SlashCommandProcessor {
    process(
        input: string,
        context: SlashCommandHostContext
    ): Promise<boolean>;

    getBusyBehavior(input: string): SlashCommandBusyBehavior;
}
