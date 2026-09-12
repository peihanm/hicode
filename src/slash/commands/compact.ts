import {buildInvokeMessages} from "../../prompt/invokeMessages.js";
import {getUserContextBlocks} from "../../prompt/attachments.js";
import {getAutoCompactThreshold, getTokenWarningState, tokenCountWithEstimation,} from "../../context/index.js";
import type {SlashCommand} from "../types.js";

export const compactCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "compact",
    description: "Compact session context; optionally specify summary requirements",
    argumentHint: "[summary instructions]",
    async execute(
        args,
        {history, ctx, onEvent, compactHistory, getToolSchemas}
    ) {
        const tools = getToolSchemas();
        const contextWindow = ctx.contextUsage.contextWindow({model: ctx.model, provider: ctx.provider, compactCount: ctx.compactState.compactCount});
        const invokeMessages = buildInvokeMessages(
            history,
            getUserContextBlocks(ctx.skills, ctx.instructions)
        );
        const preTokenCount = tokenCountWithEstimation(invokeMessages, tools);

        await onEvent({
            type: "compact_start",
            tokenCount: preTokenCount,
            threshold: getAutoCompactThreshold(ctx.model, contextWindow, ctx.contextSettings),
            trigger: "manual",
        });

        const result = await compactHistory({
            history,
            ctx,
            tools,
            preTokenCount,
            contextWindow,
            force: true,
            trigger: "manual",
            customInstructions: args.trim() || undefined,
        });

        if (!result.compacted) {
            await onEvent({
                type: "compact_error",
                message: result.message || "Compaction was not performed",
                trigger: "manual",
            });
            return;
        }

        const postInvokeMessages = buildInvokeMessages(
            history,
            getUserContextBlocks(ctx.skills, ctx.instructions)
        );
        const postTokenCount = tokenCountWithEstimation(postInvokeMessages, tools);
        const postState = getTokenWarningState(postTokenCount, ctx.model, contextWindow, ctx.contextSettings);

        await onEvent({
            type: "compact_end",
            preTokenCount,
            postTokenCount,
            trigger: "manual",
        });
        await onEvent({
            type: "token_update",
            tokenCount: postTokenCount,
            percentUsed: postState.percentUsed,
            warning: postState.warning,
            status: "estimated",
        });
    },
};
