import {release, type} from "node:os";
import {bashExecutable} from "../tools/bash/command.js";
import type {Message} from "../llm/types.js";
import {
    getActionsSection,
    getDoingTasksSection,
    getIdentitySection,
    getSystemMechanismSection,
    getToneAndStyleSection,
    getToolGuidanceSection,
    getSubagentRoleSection,
} from "./sections.js";

// Create initial History with one system message.
// Host environment facts are independent of model selection; no I/O occurs here.
export function createInitialHistory(cwd: string): Message[] {
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
        getEnvSection(cwd),
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

/** Build stable host facts without Git, file or network I/O. */
function getEnvSection(cwd: string): string {
    return ["# Environment", `Working directory: ${cwd}`, `Platform: ${type()} ${release()}`, `Shell: ${bashExecutable()}`].join("\n");
}
