import {join} from "node:path";
import type {HiCodeStorageLayout} from "../persistence/index.js";

export type AgentDefinitionScope = "user" | "project";

export function getAgentDefinitionDirectory(
    storage: HiCodeStorageLayout,
    cwd: string,
    scope: AgentDefinitionScope
): string {
    return scope === "project"
        ? join(cwd, ".hicode", "agents")
        : join(storage.hicodeHome, "agents");
}
