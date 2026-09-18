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
        "Generate one custom HiCode Agent candidate. Write system_prompt in English; write the user-facing description in the request's language.",
        "Call submit_agent_definition exactly once, with no ordinary response text.",
        "Give the agent one clear responsibility and explicit invocation criteria. Set read_only=true for investigation/review that must not change files. Ordinary tools and the main model are inherited; do not invent model tiers, turn limits or a required tool list. Child-owned Todo, Skills and Shell tasks are available within existing permissions. Do not request recursive agents, direct user questions, parent task/Memory management or automatic Git commits.",
        "Specify capability boundaries, work method and final reporting requirements. Do not claim tools outside the list.",
        `Available tools: ${availableToolNames.join(", ")}`,
        `Existing agent names: ${existingAgentNames.join(", ") || "none"}`,
        projectRules ? `Project instruction snapshot: \n${projectRules}` : "No HICODE.md instructions are provided.",
    ].join("\n\n");
}
