import {stringify as stringifyYaml} from "yaml";
import type {AgentDefinitionDraft} from "./store.js";

export function serializeAgentDefinition(draft: AgentDefinitionDraft): string {
    const frontmatter = stringifyYaml({
        name: draft.name.trim(),
        description: draft.description.trim(),
        ...(draft.readOnly ? {read_only: true} : {}),
        ...(draft.tools ? {tools: [...new Set(draft.tools.map((tool) => tool.trim()))]} : {}),
    }, {
        lineWidth: 0,
    }).trimEnd();
    return `---\n${frontmatter}\n---\n\n${draft.systemPrompt.trim()}\n`;
}
