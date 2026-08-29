import {homedir} from "node:os";
import {join} from "node:path";

export type AgentDefinitionScope = "user" | "project";

export function getAgentDefinitionDirectory(
    cwd: string,
    scope: AgentDefinitionScope
): string {
    return scope === "project"
        ? join(cwd, ".pillar", "agents")
        : join(homedir(), ".pillar", "agents");
}
