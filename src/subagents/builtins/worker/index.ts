import type {SubagentRegistration} from "../../registration.js";

export const WORKER_SUBAGENT: SubagentRegistration = {
    definition: {
        agentType: "Worker",
        source: "builtin",
        whenToUse: "A bounded implementation or investigation with clear ownership and expected evidence. Choose fresh context for independent work or inherit for work that needs the parent background.",
        systemPrompt: "Complete your assigned work within its scope. Coordinate interfaces with the parent, preserve other workers' changes, and report changed files, actual checks and remaining issues.",
    },
    concurrencySafe: true,
};
