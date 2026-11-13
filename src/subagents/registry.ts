import {boundAgentLoadIssues, normalizeAgentName} from "./load.js";
import type {SubagentRegistration} from "./definition.js";
import type {AgentDefinition, AgentLoadIssue, LoadedCustomAgents,} from "./types.js";

const WORKER_SUBAGENT: SubagentRegistration = {
    definition: {
        agentType: "Worker",
        source: "builtin",
        description: "A bounded implementation or investigation with clear ownership and expected evidence. Choose fresh context for independent work or inherit for work that needs the parent background.",
        systemPrompt: "Complete your assigned work within its scope. Coordinate interfaces with the parent, preserve other workers' changes, and report changed files, actual checks and remaining issues.",
    },
    concurrencySafe: true,
};

function immutableRegistration(
    registration: SubagentRegistration
): SubagentRegistration {
    const definition = Object.freeze({
        ...registration.definition,
        allowedTools: registration.definition.allowedTools ? Object.freeze([...registration.definition.allowedTools]) : undefined,
    });
    return Object.freeze({...registration, definition});
}

const BUILTIN_SUBAGENT_REGISTRATIONS: readonly SubagentRegistration[] =
    Object.freeze([
        immutableRegistration(WORKER_SUBAGENT),
    ]);

export interface SubagentRegistry {
    readonly issues: readonly AgentLoadIssue[];

    listDefinitions(): readonly AgentDefinition[];

    has(name: string): boolean;

    get(name: string): SubagentRegistration | undefined;
}

function validateRegistration(registration: SubagentRegistration): void {
    const {definition} = registration;
    if (definition.allowedTools?.length === 0) {
        throw new Error(`Agent ${definition.agentType} has no available tools`);
    }
}

export function createSubagentRegistry(
    custom: LoadedCustomAgents = {definitions: [], issues: []}
): SubagentRegistry {
    const registrationMap = new Map<string, SubagentRegistration>();
    const issues = [...custom.issues];

    for (const registration of BUILTIN_SUBAGENT_REGISTRATIONS) {
        validateRegistration(registration);
        const key = normalizeAgentName(registration.definition.agentType);
        if (registrationMap.has(key)) {
            throw new Error(
                `Duplicate built-in Agent type: ${registration.definition.agentType}`
            );
        }
        registrationMap.set(key, registration);
    }

    for (const definition of custom.definitions) {
        if (definition.source === "builtin") {
            throw new Error("LoadedCustomAgents must not include built-in definitions");
        }
        const key = normalizeAgentName(definition.agentType);
        const existing = registrationMap.get(key);
        if (existing?.definition.source === "builtin") {
            const details = {
                severity: "error",
                field: "name",
                message: `Custom Agents cannot override built-in type ${existing.definition.agentType}`,
            } as const;
            issues.push(definition.source === "host"
                ? {...details, source: "host", id: definition.id}
                : {...details, source: definition.source, path: definition.path}
            );
            continue;
        }
        const registration = immutableRegistration({definition, concurrencySafe: false});
        validateRegistration(registration);
        registrationMap.set(key, registration);
    }

    const definitions = Object.freeze(
        [...registrationMap.values()].map((item) => item.definition)
    );
    const boundedIssues = Object.freeze(
        boundAgentLoadIssues(issues).map((issue) => Object.freeze(issue))
    );
    return Object.freeze({
        issues: boundedIssues,
        listDefinitions: () => definitions,
        has(name: string) {
            return registrationMap.has(normalizeAgentName(name));
        },
        get(name: string) {
            return registrationMap.get(normalizeAgentName(name));
        },
    });
}

export const BUILTIN_SUBAGENT_REGISTRY = createSubagentRegistry();
