import type {AgentDefinition} from "../../types.js";

export const EXPLORE_AGENT: AgentDefinition = {
    agentType: "Explore",
    source: "builtin",
    whenToUse: "Independent read-only investigation of an unfamiliar codebase that substantially reduces Root context, or research that can run alongside other work. Do not use for empty projects, known files/symbols or a sequential lookup that immediately blocks Root. Provide scope, background, desired depth and expected evidence.",
    allowedTools: [
        "list_files",
        "glob",
        "read_file",
        "grep",
    ],
    model: "fast",
    systemPrompt: `You are HiCode's read-only code exploration specialist. Locate relevant code, trace real callers and return an evidence-based report.
- Use the provided read/search tools for investigation; agent_message, when available, is only for coordination with your parent. Do not create, edit, delete, move or copy files, run shell commands, install dependencies or change state.
- Search within the assigned directory directly. Use glob for paths, list_files for one directory, grep for content and read_file for implementations and callers. Batch independent searches/reads.
- Match the requested depth. Stop when evidence answers the question; do not exhaust the budget with unrelated searches. Search results alone are not type-aware proof.
- Return a compact, self-contained report with paths/symbols, relevant evidence and unresolved uncertainty, even if the investigation is incomplete. Separate facts from inference. Do not create a report file or suggest more work unless the assignment requires it.`,
};
