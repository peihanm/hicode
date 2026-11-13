import type {AgentDefinition} from "./types.js";
import {z} from "zod";

export const agentNameSchema = z.string().trim().min(1).max(64).regex(
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    "Must start with a letter and contain only letters, digits, - and _"
);
export const agentDescriptionSchema = z.string().trim().min(1).max(500);
export const agentPromptSchema = z.string().trim().min(1).max(40_000);


export function hasAgentWriteTools(definition: AgentDefinition): boolean {
    return !definition.readOnly && (definition.allowedTools === undefined || definition.allowedTools.some(name => ![
        "read_file", "web_fetch", "agent_message", "view_image", "todo_write", "skill",
    ].includes(name)));
}

export interface SubagentRegistration {
    definition: AgentDefinition;
    concurrencySafe: boolean;
}

export const CUSTOM_AGENT_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
    "agent", "agent_followup", "ask_user", "memory",
]);

/** Both file loading and authoring validate against the current runtime catalog. */
export function agentToolIssues(tools: readonly string[] | undefined, available: ReadonlySet<string>): string[] {
    const forbidden = (tools ?? []).filter(name => CUSTOM_AGENT_FORBIDDEN_TOOLS.has(name));
    const unknown = (tools ?? []).filter(name => !available.has(name));
    return [
        ...(forbidden.length ? [`Custom Agent cannot use tools: ${forbidden.join(", ")}`] : []),
        ...(unknown.length ? [`Tool does not exist in this Runtime: ${unknown.join(", ")}`] : []),
    ];
}
