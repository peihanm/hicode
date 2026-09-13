/** Runtime-assigned identities; message text never grants user authority. */
export interface AgentMessageRoute {
    sender: string;
    recipient: string;
    runCount: number;
    intent: "message" | "followup";
}

export interface AgentMessaging {
    send(target: string, message: string): Promise<{messageId: string}>;
    wait(timeoutMs: number, signal: AbortSignal): Promise<"message" | "timeout">;
}
