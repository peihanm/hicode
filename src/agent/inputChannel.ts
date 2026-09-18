import type {MessageContent} from "../images/content.js";
type AgentInputSource = "user_input" | "task_notification" | "agent_message";

export interface QueuedAgentInput {
    id: string;
    source: AgentInputSource;
    content: MessageContent;
    /** Only task_notification carries this; consume terminal task state without parsing display text. */
    taskId?: string;
}

/** The Agent reads this channel only at safe boundaries. It has no UI dependency and cannot interrupt tool batches. */
export interface AgentInputChannel {
    drainInitial(): readonly QueuedAgentInput[];

    drainSafeBoundary(): readonly QueuedAgentInput[];

    waitForInput(signal: AbortSignal): Promise<void>;
}

export const EMPTY_AGENT_INPUT_CHANNEL: AgentInputChannel = {
    drainInitial: () => [],
    drainSafeBoundary: () => [],
    waitForInput: signal => new Promise((_, reject) => {
        if (signal.aborted) {reject(signal.reason); return;}
        signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }),
};
