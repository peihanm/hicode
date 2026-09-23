import {isAbsolute, relative, resolve, sep} from "node:path";
import type {McpConfigSource} from "../mcp/types.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import {normalizeHiCodeStorageLayout} from "../persistence/layout.js";
import type {InstructionFileSource} from "../prompt/instructions.js";
import type {ResolvedHiCodeSettings, SettingsFileSource,} from "../settings/index.js";
import type {SkillFileSource} from "../skills/types.js";
import type {AgentFileSource} from "../subagents/types.js";
import {
    normalizeHiCodeRootContributions,
    type HiCodeRootContributions,
} from "./rootContributions.js";

export type {
    HostAgentContribution,
    HostInstructionContribution,
    HostSkillContribution,
    HiCodeRootContributions,
} from "./rootContributions.js";
export type {HostMcpServerContribution} from "../mcp/types.js";

export interface HiCodeFileSources {
    readonly settings: readonly SettingsFileSource[];
    readonly instructions: readonly InstructionFileSource[];
    readonly skills: readonly SkillFileSource[];
    readonly agents: readonly AgentFileSource[];
    readonly mcp: readonly McpConfigSource[];
}

const rootConfigurationBrand: unique symbol = Symbol("HiCodeRootConfiguration");

export interface HiCodeRootConfiguration {
    readonly allowFullAccess: boolean;
    readonly [rootConfigurationBrand]: true;
    readonly cwd: string;
    /** Host access ceiling (filesystem root in CLI), not the current project directory. */
    readonly workspaceBoundary: string;
    readonly storage: HiCodeStorageLayout;
    readonly settings: ResolvedHiCodeSettings;
    readonly fileSources: HiCodeFileSources;
    readonly contributions: HiCodeRootContributions;
}

interface CreateHiCodeRootConfigurationOptions {
    allowFullAccess?: boolean;
    cwd: string;
    workspaceBoundary: string;
    storage: HiCodeStorageLayout;
    settings: ResolvedHiCodeSettings;
    fileSources: HiCodeFileSources;
    rootContributions?: HiCodeRootContributions;
}

export const CLI_FILE_SOURCES: HiCodeFileSources = freezeFileSources({
    settings: ["user", "project", "local"],
    instructions: ["user", "project", "local"],
    skills: ["user", "project"],
    agents: ["user", "project"],
    mcp: ["user", "project"],
});

export function createHiCodeRootConfiguration(
    options: CreateHiCodeRootConfigurationOptions
): HiCodeRootConfiguration {
    const cwd = requireAbsolutePath(options.cwd, "cwd");
    const workspaceBoundary = requireAbsolutePath(
        options.workspaceBoundary,
        "workspaceBoundary"
    );
    assertContains(workspaceBoundary, cwd);
    if (options.allowFullAccess !== undefined && typeof options.allowFullAccess !== "boolean") throw new Error("allowFullAccess must be boolean");
    if (options.settings.permissions.defaultMode === "full-access" && !options.allowFullAccess) throw new Error("This Host does not allow Full Access");
    const configuration: HiCodeRootConfiguration = {
        [rootConfigurationBrand]: true,
        allowFullAccess: options.allowFullAccess ?? false,
        cwd,
        workspaceBoundary,
        storage: normalizeHiCodeStorageLayout(options.storage),
        settings: immutableCopy(options.settings),
        fileSources: normalizeHiCodeFileSources(options.fileSources),
        contributions: normalizeHiCodeRootContributions(
            options.rootContributions
        ),
    };
    freezeUnknown(configuration);
    return configuration;
}

export function isHiCodeRootConfiguration(
    value: unknown
): value is HiCodeRootConfiguration {
    return Boolean(
        value &&
        typeof value === "object" &&
        rootConfigurationBrand in value &&
        value[rootConfigurationBrand] === true
    );
}

export function normalizeHiCodeFileSources(
    sources: HiCodeFileSources
): HiCodeFileSources {
    if (!sources || typeof sources !== "object") {
        throw new Error("fileSources must be an object");
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
        throw new Error(`fileSources.${domain} must be an array`);
    }
    const allowedSet = new Set<string>(allowed);
    const seen = new Set<string>();
    for (const value of values) {
        if (!allowedSet.has(value)) {
            throw new Error(`fileSources.${domain} contains invalid source ${String(value)}`);
        }
        if (seen.has(value)) {
            throw new Error(`fileSources.${domain} contains duplicate source ${value}`);
        }
        seen.add(value);
    }
    return Object.freeze(allowed.filter((value) => seen.has(value)));
}

function freezeFileSources(sources: HiCodeFileSources): HiCodeFileSources {
    const frozen: HiCodeFileSources = {
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
        throw new Error(`${name} must be a non-empty absolute path`);
    }
    const path = resolve(value.trim());
    if (!isAbsolute(value.trim())) {
        throw new Error(`${name} must be an absolute path`);
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
        throw new Error("workspaceBoundary does not contain cwd");
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
