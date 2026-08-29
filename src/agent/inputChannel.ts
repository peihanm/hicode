type AgentInputSource = "user_input" | "task_notification";

export interface QueuedAgentInput {
    id: string;
    source: AgentInputSource;
    content: string;
    /** 仅 task_notification 携带，用于消费任务终态而不解析展示文案。 */
    taskId?: string;
}

/**
 * Agent 只在安全边界读取该通道。通道不知道 UI，也不能中断工具批次。
 */
export interface AgentInputChannel {
    drainInitial(): readonly QueuedAgentInput[];

    drainSafeBoundary(): readonly QueuedAgentInput[];
}

export const EMPTY_AGENT_INPUT_CHANNEL: AgentInputChannel = {
    drainInitial: () => [],
    drainSafeBoundary: () => [],
};
