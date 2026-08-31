import {EXPLORE_SUBAGENT} from "./builtins/explore/index.js";
import {GENERAL_PURPOSE_SUBAGENT} from "./builtins/generalPurpose/index.js";
import {VERIFICATION_SUBAGENT} from "./builtins/verification/index.js";
import {createCustomSubagentRegistration} from "./custom.js";
import {boundAgentLoadIssues, normalizeAgentName} from "./load.js";
import type {SubagentRegistration} from "./registration.js";
import type {AgentDefinition, AgentLoadIssue, LoadedCustomAgents,} from "./types.js";

function immutableRegistration(
    registration: SubagentRegistration
): SubagentRegistration {
    const definition = Object.freeze({
        ...registration.definition,
        allowedTools: Object.freeze([...registration.definition.allowedTools]),
    });
    return Object.freeze({...registration, definition});
}

const BUILTIN_SUBAGENT_REGISTRATIONS: readonly SubagentRegistration[] =
    Object.freeze([
        immutableRegistration(EXPLORE_SUBAGENT),
        immutableRegistration(GENERAL_PURPOSE_SUBAGENT),
        immutableRegistration(VERIFICATION_SUBAGENT),
    ]);

export interface SubagentRegistry {
    readonly issues: readonly AgentLoadIssue[];

    listDefinitions(): readonly AgentDefinition[];

    has(name: string): boolean;

    get(name: string): SubagentRegistration | undefined;
}

function validateRegistration(registration: SubagentRegistration): void {
    const {definition} = registration;
    if (definition.allowedTools.length === 0) {
        throw new Error(`Agent ${definition.agentType} 没有可用工具`);
    }
    if (
        definition.maxIterations !== undefined &&
        (!Number.isInteger(definition.maxIterations) ||
            definition.maxIterations < 2)
    ) {
        throw new Error(`Agent ${definition.agentType} 的 maxIterations 无效`);
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
                `重复的内置 Agent 类型: ${registration.definition.agentType}`
            );
        }
        registrationMap.set(key, registration);
    }

    for (const definition of custom.definitions) {
        if (definition.source === "builtin") {
            throw new Error("LoadedCustomAgents 不能包含 builtin 定义");
        }
        const key = normalizeAgentName(definition.agentType);
        const existing = registrationMap.get(key);
        if (existing?.definition.source === "builtin") {
            const details = {
                severity: "error",
                field: "name",
                message: `自定义 Agent 不能覆盖内置类型 ${existing.definition.agentType}`,
            } as const;
            issues.push(definition.source === "host"
                ? {...details, source: "host", id: definition.id}
                : {...details, source: definition.source, path: definition.path}
            );
            continue;
        }
        const runtimeDefinition = Object.freeze({
            ...definition,
            allowedTools: Object.freeze([...definition.allowedTools]),
        });
        const registration = immutableRegistration(
            createCustomSubagentRegistration(runtimeDefinition)
        );
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
