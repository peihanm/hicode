import {isAbsolute, relative, resolve, sep} from "node:path";
import type {McpConfigSource} from "../mcp/types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {normalizePillarStorageLayout} from "../persistence/layout.js";
import type {InstructionFileSource} from "../prompt/instructions.js";
import type {ResolvedPillarSettings, SettingsFileSource,} from "../settings/index.js";
import type {SkillFileSource} from "../skills/types.js";
import type {AgentFileSource} from "../subagents/types.js";
import {
    normalizePillarRootContributions,
    type PillarRootContributions,
} from "./rootContributions.js";

export type {
    HostAgentContribution,
    HostInstructionContribution,
    HostSkillContribution,
    PillarRootContributions,
} from "./rootContributions.js";
export type {HostMcpServerContribution} from "../mcp/types.js";

export interface PillarFileSources {
    readonly settings: readonly SettingsFileSource[];
    readonly instructions: readonly InstructionFileSource[];
    readonly skills: readonly SkillFileSource[];
    readonly agents: readonly AgentFileSource[];
    readonly mcp: readonly McpConfigSource[];
}

const rootConfigurationBrand: unique symbol = Symbol("PillarRootConfiguration");

export interface PillarRootConfiguration {
    readonly allowFullAccess: boolean;
    readonly [rootConfigurationBrand]: true;
    readonly cwd: string;
    readonly workspaceBoundary: string;
    readonly storage: PillarStorageLayout;
    readonly settings: ResolvedPillarSettings;
    readonly fileSources: PillarFileSources;
    readonly contributions: PillarRootContributions;
}

export interface CreatePillarRootConfigurationOptions {
    allowFullAccess?: boolean;
    cwd: string;
    workspaceBoundary: string;
    storage: PillarStorageLayout;
    settings: ResolvedPillarSettings;
    fileSources: PillarFileSources;
    rootContributions?: PillarRootContributions;
}

export const CLI_FILE_SOURCES: PillarFileSources = freezeFileSources({
    settings: ["user", "project", "local"],
    instructions: ["user", "project", "local"],
    skills: ["user", "project"],
    agents: ["user", "project"],
    mcp: ["user", "project"],
});

export function createPillarRootConfiguration(
    options: CreatePillarRootConfigurationOptions
): PillarRootConfiguration {
    const cwd = requireAbsolutePath(options.cwd, "cwd");
    const workspaceBoundary = requireAbsolutePath(
        options.workspaceBoundary,
        "workspaceBoundary"
    );
    assertContains(workspaceBoundary, cwd);
    if (options.allowFullAccess !== undefined && typeof options.allowFullAccess !== "boolean") throw new Error("allowFullAccess 必须是 boolean");
    if (options.settings.permissions.defaultMode === "full-access" && !options.allowFullAccess) throw new Error("当前 Host 不允许 Full Access");
    const configuration: PillarRootConfiguration = {
        [rootConfigurationBrand]: true,
        allowFullAccess: options.allowFullAccess ?? false,
        cwd,
        workspaceBoundary,
        storage: normalizePillarStorageLayout(options.storage),
        settings: immutableCopy(options.settings),
        fileSources: normalizePillarFileSources(options.fileSources),
        contributions: normalizePillarRootContributions(
            options.rootContributions
        ),
    };
    freezeUnknown(configuration);
    return configuration;
}

export function isPillarRootConfiguration(
    value: unknown
): value is PillarRootConfiguration {
    return Boolean(
        value &&
        typeof value === "object" &&
        rootConfigurationBrand in value &&
        value[rootConfigurationBrand] === true
    );
}

export function normalizePillarFileSources(
    sources: PillarFileSources
): PillarFileSources {
    if (!sources || typeof sources !== "object") {
        throw new Error("fileSources 必须是对象");
    }
    return freezeFileSources({
        settings: normalizeSources(
            sources.settings,
            ["user", "project", "local"],
            "settings"
        ),
        instructions: normalizeSources(
            sources.instructions,
            ["user", "project", "local"],
            "instructions"
        ),
        skills: normalizeSources(
            sources.skills,
            ["user", "project"],
            "skills"
        ),
        agents: normalizeSources(
            sources.agents,
            ["user", "project"],
            "agents"
        ),
        mcp: normalizeSources(
            sources.mcp,
            ["user", "project"],
            "mcp"
        ),
    });
}

function normalizeSources<T extends string>(
    values: readonly T[],
    allowed: readonly T[],
    domain: string
): readonly T[] {
    if (!Array.isArray(values)) {
        throw new Error(`fileSources.${domain} 必须是数组`);
    }
    const allowedSet = new Set<string>(allowed);
    const seen = new Set<string>();
    for (const value of values) {
        if (!allowedSet.has(value)) {
            throw new Error(`fileSources.${domain} 包含无效来源 ${String(value)}`);
        }
        if (seen.has(value)) {
            throw new Error(`fileSources.${domain} 包含重复来源 ${value}`);
        }
        seen.add(value);
    }
    return Object.freeze(allowed.filter((value) => seen.has(value)));
}

function freezeFileSources(sources: PillarFileSources): PillarFileSources {
    const frozen: PillarFileSources = {
        settings: Object.freeze([...sources.settings]),
        instructions: Object.freeze([...sources.instructions]),
        skills: Object.freeze([...sources.skills]),
        agents: Object.freeze([...sources.agents]),
        mcp: Object.freeze([...sources.mcp]),
    };
    return Object.freeze(frozen);
}

function requireAbsolutePath(value: string, name: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${name} 必须是非空绝对路径`);
    }
    const path = resolve(value.trim());
    if (!isAbsolute(value.trim())) {
        throw new Error(`${name} 必须是绝对路径`);
    }
    return path;
}

function assertContains(boundary: string, cwd: string): void {
    const relation = relative(boundary, cwd);
    if (
        relation === ".." ||
        relation.startsWith(`..${sep}`) ||
        isAbsolute(relation)
    ) {
        throw new Error("workspaceBoundary 不包含 cwd");
    }
}

function immutableCopy<T>(value: T): T {
    const copy = structuredClone(value);
    freezeUnknown(copy);
    return copy;
}

function freezeUnknown(value: unknown): void {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freezeUnknown(child);
    Object.freeze(value);
}
