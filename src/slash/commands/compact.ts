import {buildInvokeMessages} from "../../prompt/invokeMessages.js";
import {getUserContextBlocks} from "../../prompt/attachments.js";
import {getAutoCompactThreshold, getTokenWarningState, tokenCountWithEstimation,} from "../../context/index.js";
import type {SlashCommand} from "../types.js";

export const compactCommand: SlashCommand = {
    busyBehavior: "defer",
    name: "compact",
    description: "压缩当前会话上下文；可追加自定义总结要求",
    argumentHint: "[summary instructions]",
    async execute(
        args,
        {history, ctx, onEvent, compactHistory, getToolSchemas}
    ) {
        const tools = getToolSchemas();
        const invokeMessages = buildInvokeMessages(
            history,
            getUserContextBlocks(ctx.skills, ctx.instructions)
        );
        const preTokenCount = tokenCountWithEstimation(invokeMessages, tools);

        await onEvent({
            type: "compact_start",
            tokenCount: preTokenCount,
            threshold: getAutoCompactThreshold(ctx.model),
            trigger: "manual",
        });

        const result = await compactHistory({
            history,
            ctx,
            tools,
            preTokenCount,
            force: true,
            trigger: "manual",
            customInstructions: args.trim() || undefined,
        });

        if (!result.compacted) {
            await onEvent({
                type: "compact_error",
                message: result.message || "未执行压缩",
                trigger: "manual",
            });
            return;
        }

        const postInvokeMessages = buildInvokeMessages(
            history,
            getUserContextBlocks(ctx.skills, ctx.instructions)
        );
        const postTokenCount = tokenCountWithEstimation(postInvokeMessages, tools);
        const postState = getTokenWarningState(postTokenCount, ctx.model);

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
