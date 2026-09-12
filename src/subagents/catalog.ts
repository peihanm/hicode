import {createSubagentRegistry, type SubagentRegistry} from "./registry.js";
import {boundAgentLoadIssues} from "./load.js";
import type {AgentDefinition, AgentLoadIssue, LoadedCustomAgents,} from "./types.js";

export interface AgentCatalogUpdate {
    revision: number;
    added: readonly string[];
    updated: readonly string[];
    removed: readonly string[];
    issues: readonly AgentLoadIssue[];
}

export interface SubagentCatalog extends SubagentRegistry {
    readonly revision: number;

    reload(): Promise<AgentCatalogUpdate>;
}

function definitionFingerprint(definition: AgentDefinition): string {
    return JSON.stringify({
        agentType: definition.agentType,
        whenToUse: definition.whenToUse,
        systemPrompt: definition.systemPrompt,
        allowedTools: definition.allowedTools,
        model: definition.model,
        maxIterations: definition.maxIterations,
        source: definition.source,
        origin: definition.source === "host"
            ? definition.id
            : definition.source === "builtin"
                ? "builtin"
                : definition.path,
    });
}

function definitionMap(registry: SubagentRegistry): Map<string, AgentDefinition> {
    return new Map(
        registry.listDefinitions().map((definition) => [
            definition.agentType.toLocaleLowerCase("en-US"),
            definition,
        ])
    );
}

function compareRegistries(
    previous: SubagentRegistry,
    next: SubagentRegistry
): Pick<AgentCatalogUpdate, "added" | "updated" | "removed"> {
    const before = definitionMap(previous);
    const after = definitionMap(next);
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const [key, definition] of after) {
        const existing = before.get(key);
        if (!existing) added.push(definition.agentType);
        else if (
            definitionFingerprint(existing) !== definitionFingerprint(definition)
        ) {
            updated.push(definition.agentType);
        }
    }
    for (const [key, definition] of before) {
        if (!after.has(key)) removed.push(definition.agentType);
    }
    const sort = (values: string[]) => values.sort((left, right) =>
        left.localeCompare(right, "en")
    );
    return {added: sort(added), updated: sort(updated), removed: sort(removed)};
}

export function createSubagentCatalog({
    initial,
    load,
}: {
    initial?: LoadedCustomAgents;
    load(): Promise<LoadedCustomAgents>;
}): SubagentCatalog {
    let active = createSubagentRegistry(initial);
    let revision = 1;
    let reloadIssues: readonly AgentLoadIssue[] = [];

    return {
        get revision() {
            return revision;
        },
        get issues() {
            return reloadIssues.length > 0
                ? Object.freeze([...active.issues, ...reloadIssues])
                : active.issues;
        },
        listDefinitions() {
            return active.listDefinitions();
        },
        has(name) {
            return active.has(name);
        },
        get(name) {
            return active.get(name);
        },
        async reload() {
            let next: SubagentRegistry;
            try {
                const loaded: LoadedCustomAgents = await load();
                next = createSubagentRegistry(loaded);
            } catch (error) {
                reloadIssues = Object.freeze(boundAgentLoadIssues([{
                    source: "project",
                    path: "<agent catalog>",
                    severity: "error",
                    message: `Agent Reload failed; continuing with revision ${revision}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                }]));
                return {
                    revision,
                    added: [],
                    updated: [],
                    removed: [],
                    issues: this.issues,
                };
            }

            const changes = compareRegistries(active, next);
            active = next;
            reloadIssues = [];
            revision += 1;
            return {
                revision,
                ...changes,
                issues: active.issues,
            };
        },
    };
}
