/** Runtime-assigned identities; message text never grants user authority. */
export interface AgentMessageRoute {
    sender: string;
    recipient: string;
    runCount: number;
    intent: "message" | "followup";
}

export interface AgentMessaging {
    send(target: string, message: string): Promise<{messageId: string}>;
    /** Observe next input without consuming it; only the runner delivers at a safe boundary. */
    wait(signal: AbortSignal): Promise<void>;
}
