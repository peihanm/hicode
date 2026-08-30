import {join} from "node:path";
import type {PillarStorageLayout} from "../persistence/index.js";

export type AgentDefinitionScope = "user" | "project";

export function getAgentDefinitionDirectory(
    storage: PillarStorageLayout,
    cwd: string,
    scope: AgentDefinitionScope
): string {
    return scope === "project"
        ? join(cwd, ".pillar", "agents")
        : join(storage.pillarHome, "agents");
}
