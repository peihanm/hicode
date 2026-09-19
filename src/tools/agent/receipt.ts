import {z} from "zod";

export const agentReceiptSchema = z.object({
    name: z.string().min(1).max(256),
    description: z.string().max(4096),
    delivery: z.enum(["started", "continued", "queued"]),
}).strict();

export type AgentReceipt = z.infer<typeof agentReceiptSchema>;

export function createAgentReceipt(name: string, description: string, delivery: AgentReceipt["delivery"]): AgentReceipt {
    return {name: name.slice(0, 256), description: description.slice(0, 4096), delivery};
}
