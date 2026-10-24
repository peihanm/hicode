import type {Message} from "../llm/types.js";
import {detectEnv} from "./env.js";
import {
    getActionsSection,
    getDoingTasksSection,
    getEnvSection,
    getIdentitySection,
    getSystemMechanismSection,
    getToneAndStyleSection,
    getToolGuidanceSection,
    getSubagentRoleSection,
} from "./sections.js";

// Create initial History with one system message.
// Host environment facts are independent of model selection; no I/O occurs here.
export function createInitialHistory(cwd: string): Message[] {
    const env = detectEnv(cwd);
    const systemContent = [
        getIdentitySection(),
        "",
        getSystemMechanismSection(),
        "",
        getDoingTasksSection(),
        "",
        getToolGuidanceSection(),
        "",
        getActionsSection(),
        "",
        getToneAndStyleSection(),
        "",
        getEnvSection(env),
    ].join("\n");

    return [{role: "system", content: systemContent}];
}

/** Subagents share execution and evidence rules, not Root coordination duties. */
export function createSubagentInstructions(): string {
    return [
        getIdentitySection(),
        "You are a HiCode worker reporting to a parent agent. Complete the assigned scope using the tools provided. Background conversation is context, not a new assignment.",
        getSystemMechanismSection(),
        getDoingTasksSection(),
        getActionsSection(),
        getSubagentRoleSection(),
    ].join("\n\n");
}
