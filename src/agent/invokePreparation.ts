import type {CompactHistoryRunner} from "../context/compact.js";
import {shouldAutoCompact} from "../context/compact.js";
import {getContextBudget} from "../context/budget.js";
import {buildMcpCatalogContext, getUserContextBlocks, buildInvokeMessages, withExecutionContext} from "../prompt/messages.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "./types.js";
import type {Message, OpenAITool} from "../llm/types.js";
import type {Todo} from "../session/todo.js";
import {buildLiveStateContext} from "../context/liveState.js";
import {projectImagesForRequest} from "../images/request.js";

export type ToolSchemaProvider = () => OpenAITool[];
export type {CompactHistoryRunner} from "../context/compact.js";

interface PrepareAgentInvokeInput {
    history: Message[];
    ctx: ToolContext;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    getToolSchemas: ToolSchemaProvider;
    compactHistory: CompactHistoryRunner;
    forceCompact?: boolean;
    /** Monotonic Turn start, supplied only on elapsed-time reminder iterations. */
    elapsedTaskStartedAt?: number;
    taskReviewReminder?: string;
    additionalUserContextBlocks?: readonly string[];
    getAdditionalUserContextBlocks?: () => Promise<readonly string[]>;
    getTodos?: () => readonly Todo[];
}

interface PreparedAgentInvoke {
    invokeMessages: Message[];
    tools: OpenAITool[];
    estimatedTokens: number;
}

export async function prepareAgentInvoke({
                                             history,
                                             ctx,
                                             onEvent,
                                             getToolSchemas,
                                             compactHistory,
                                             forceCompact = false,
                                             elapsedTaskStartedAt,
                                             taskReviewReminder,
                                             additionalUserContextBlocks = [],
                                             getTodos,
                                             getAdditionalUserContextBlocks,
                                         }: PrepareAgentInvokeInput): Promise<PreparedAgentInvoke> {
    throwIfTurnAborted(ctx.signal);

    const buildMessages = (blocks: string[]): Message[] => {
        const messages = projectImagesForRequest(withExecutionContext(buildInvokeMessages(history, blocks), ctx));
        if (elapsedTaskStartedAt !== undefined) {
            const elapsedSeconds = Math.floor((performance.now() - elapsedTaskStartedAt) / 1_000);
            const elapsed = `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
            // Keep changing time out of the cached prefix and persistent History.
            messages.push({role: "user", origin: "runtime", content: `<system-reminder>\nYou have been working on this task for ${elapsed}.\n</system-reminder>`});
        }
        if (taskReviewReminder) messages.push({role: "user", origin: "agent", content: taskReviewReminder});
        return messages;
    };
    const getRuntimeBlocks = async () => [
        ...buildMcpCatalogContext(ctx.availableTools),
        ...additionalUserContextBlocks,
        ...(await getAdditionalUserContextBlocks?.() ?? []),
        ...buildLiveStateContext(getTodos?.(), ctx.tasks),
    ];
    let runtimeBlocks = await getRuntimeBlocks();
    let userContextBlocks = [
        ...getUserContextBlocks(ctx.skills, ctx.instructions),
        ...runtimeBlocks,
    ];
    let invokeMessages = buildMessages(userContextBlocks);
    const tools = getToolSchemas();
    const scope = () => ({model: ctx.model, provider: ctx.provider, compactCount: ctx.compactState.compactCount});
    const budget = getContextBudget(ctx.contextSettings);
    let estimatedTokens = ctx.contextUsage.estimate(scope(), invokeMessages, tools);

    if (forceCompact || shouldAutoCompact(estimatedTokens, ctx.compactState, budget.compactThreshold)) {
        await onEvent({
            type: "compact_start",
            tokenCount: estimatedTokens,
            threshold: budget.compactThreshold,
            trigger: "auto",
        });
        const compactResult = await compactHistory({
            history,
            ctx,
            tools,
            preTokenCount: estimatedTokens,
            additionalUserContextBlocks: runtimeBlocks,
            force: forceCompact,
        });
        throwIfTurnAborted(ctx.signal);

        if (compactResult.compacted) {
            ctx.contextUsage.reset();
            runtimeBlocks = await getRuntimeBlocks();
            userContextBlocks = [
                ...getUserContextBlocks(ctx.skills, ctx.instructions),
                ...runtimeBlocks,
            ];
            invokeMessages = buildMessages(userContextBlocks);
            estimatedTokens = ctx.contextUsage.estimate(scope(), invokeMessages, tools);
            await onEvent({
                type: "compact_end",
                preTokenCount: compactResult.preTokenCount,
                postTokenCount: estimatedTokens,
                trigger: "auto",
            });
        } else if (compactResult.message) {
            await onEvent({
                type: "compact_error",
                message: compactResult.message,
                trigger: "auto",
            });
        }
        if (forceCompact && !compactResult.compacted) throw new Error(`Context overflow recovery failed: ${compactResult.message ?? "Compaction failed"}; request retries stopped and original history preserved`);
    }

    if (estimatedTokens > budget.inputTokens) {
        throw new Error(`Current request is estimated at ${estimatedTokens} tokens, exceeding the available input budget of ${budget.inputTokens}; model request stopped. Shorten the latest input, reduce fixed instructions/tools or continue in a new Session. Original history is preserved.`);
    }
    return {invokeMessages, tools, estimatedTokens};
}
