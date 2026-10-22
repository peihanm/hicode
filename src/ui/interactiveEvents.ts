import type {HookInput} from "../hooks/types.js";
import {createContext} from "react";
import type {AgentEvent} from "../agent/types.js";

/** Opt-in host observation; it cannot submit input or approve tools. */
export type InteractiveEvent =
    | {type: "ready"; sessionId: string}
    | {type: "agent_event"; sessionId: string; event: AgentEvent}
    | {type: "state"; sessionId: string; busy: boolean; waitingForApproval: boolean}
    | {type: "settled"; sessionId: string; reason: string; status: Extract<HookInput, {hook_event_name: "TurnEnd"}>["status"]; persistenceStatus: "saved" | "failed"; runningAgents: number; pendingAgentMessages: number};

export const InteractiveEvents = createContext<{emit(event: InteractiveEvent): void} | undefined>(undefined);
