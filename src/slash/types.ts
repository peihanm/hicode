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
    openRewind?: () => void;
    openAgents?: () => void;
    openGitDiff?: () => void;
}

export type SlashCommandHostContext = Omit<
    SlashCommandContext,
    "compactHistory" | "getToolSchemas" | "subagents" | "memory"
>;

interface SlashCommandBase {
    name: string;
    aliases?: string[];
    description: string;
    argumentHint?: string;
}

export interface LocalSlashCommand extends SlashCommandBase {
    kind: "local";
    busyBehavior: "defer" | "immediate";

    execute(
        args: string,
        context: SlashCommandContext
    ): Promise<void>;
}

export interface PromptSlashCommandDefinition extends SlashCommandBase {
    kind: "prompt";

    execute(
        args: string,
        context: SlashCommandContext
    ): Promise<SlashPromptCommand>;
}

export type SlashCommand = LocalSlashCommand | PromptSlashCommandDefinition;

export interface SlashPromptCommand {
    kind: "prompt";
    prompt: string;
    /** 只约束该 Prompt Slash 启动的当前 Agent Turn，不改变 Session 权限。 */
    allowedTools?: readonly string[];
}

export type SlashCommandProcessResult = boolean | SlashPromptCommand;

export type SlashCommandBusyBehavior = "defer" | "immediate";

export interface SlashCommandProcessor {
    process(
        input: string,
        context: SlashCommandHostContext
    ): Promise<SlashCommandProcessResult>;

    getBusyBehavior(input: string): SlashCommandBusyBehavior;
}
