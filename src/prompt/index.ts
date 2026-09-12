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
} from "./sections.js";

// Create initial History with one system message.
// cwd/model provide stable host facts; no I/O occurs here.
export function createInitialHistory(cwd: string, model: string): Message[] {
    const env = detectEnv(cwd, model);
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

export function updateInitialHistoryModel(
    history: readonly Message[],
    model: string
): Message[] {
    const [system, ...conversation] = history;
    if (!system || system.role !== "system") return [...history];
    return [{
        role: "system",
        content: system.content.replace(/^Model:.*$/m, `Model: ${model}`),
    }, ...conversation];
}
