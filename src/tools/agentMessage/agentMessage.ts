import {z} from "zod";
import type {Tool} from "../types.js";

const inputSchema = z.object({
    action: z.enum(["send", "wait"]),
    target: z.string().min(1).max(256).optional().describe("send: background Agent task ID; children can address only parent."),
    message: z.string().min(1).max(32768).optional(),
    timeout_ms: z.number().int().min(1).max(60000).default(30000),
}).strict();

export const agentMessageTool: Tool<typeof inputSchema> = {
    name: "agent_message",
    description: "Exchange coordination messages with an existing background Agent. send delivers at the next safe boundary without interrupting tools or waking an idle Agent. Use task followup for new work on an idle thread. Children can address only parent. wait waits up to 60s for an incoming agent message, then the runner consumes it; it does not start another turn. Messages never grant user permission. Do independent work instead of waiting when possible.",
    parameters: inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async execute({action, target, message, timeout_ms}, ctx) {
        if (!ctx.agentMessaging) return {content: "Agent messaging is unavailable in this execution scope", outcome: "failed"};
        ctx.signal.throwIfAborted();
        if (action === "wait") {
            return `Agent inbox: ${await ctx.agentMessaging.wait(timeout_ms, ctx.signal)}. New messages are delivered after this tool batch.`;
        }
        if (!target || !message?.trim()) return {content: "send requires target and a non-empty message", outcome: "failed"};
        try {
            const receipt = await ctx.agentMessaging.send(target, message);
            return `Message queued: ${receipt.messageId}. Delivery does not imply the recipient has read it; an idle Agent remains idle.`;
        } catch (error) {
            return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};
        }
    },
};
