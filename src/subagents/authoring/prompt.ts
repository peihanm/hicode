import type {ProjectInstructions} from "../../prompt/instructions.js";

const MAX_INSTRUCTION_CHARS = 20_000;

export function createAgentAuthoringPrompt({
    availableToolNames,
    existingAgentNames,
    instructions,
}: {
    availableToolNames: readonly string[];
    existingAgentNames: readonly string[];
    instructions: ProjectInstructions;
}): string {
    const projectRules = instructions.files
        .map((file) =>
            `### ${file.scope === "host" ? `host:${file.id}` : file.path}\n${file.content}`
        )
        .join("\n\n")
        .slice(0, MAX_INSTRUCTION_CHARS);
    return [
        "Generate one custom Pillar Agent candidate. Write system_prompt in English; write the user-facing description in the request's language.",
        "Call submit_agent_definition exactly once, with no ordinary response text.",
        "Give the agent one clear responsibility, explicit invocation criteria and minimal tools. Do not request Agent, Task, Memory, Plan, Todo or Skill control capabilities, or require automatic Git commits.",
        "Specify capability boundaries, work method and final reporting requirements. Do not claim tools outside the list.",
        `Available tools: ${availableToolNames.join(", ")}`,
        `Existing agent names: ${existingAgentNames.join(", ") || "none"}`,
        projectRules ? `Project instruction snapshot: \n${projectRules}` : "No PILLAR.md instructions are provided.",
    ].join("\n\n");
}
