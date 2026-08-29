import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {PermissionMode, PermissionRules,} from "../permissions/types.js";
import type {HooksSettingsFile, ResolvedHookSettings,} from "../hooks/types.js";

export type SettingsFileSource = "user" | "project" | "local";
type SettingsValueSource =
    | "default"
    | SettingsFileSource
    | "environment"
    | "cli";

interface PermissionSettingsFile {
    defaultMode?: PermissionMode;
    allow?: string[];
    ask?: string[];
    deny?: string[];
    [key: string]: unknown;
}

interface MemorySettingsFile {
    enabled?: boolean;
    autoExtract?: boolean;
    [key: string]: unknown;
}

interface CheckpointingSettingsFile {
    enabled?: boolean;
    [key: string]: unknown;
}

interface SandboxSettingsFile {
    enabled?: boolean;
    filesystem?: {
        allowWrite?: string[];
        denyRead?: string[];
        denyWrite?: string[];
        [key: string]: unknown;
    };
    network?: {
        allowedDomains?: string[];
        allowLocalBinding?: boolean;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface ModelDefinitionSettings {
    id: string;
    label: string;
}

export interface ModelSourceSettings {
    id: LLMProviderName;
    label: string;
    apiKeyEnv: string;
    baseUrl?: string;
    models: readonly ModelDefinitionSettings[];
}

export interface ModelTargetSettings {
    source: LLMProviderName;
    provider: LLMProviderName;
    model: string;
    label: string;
}

interface ModelTargetSettingsFile {
    source?: LLMProviderName;
    model?: string;
    [key: string]: unknown;
}

interface ModelDefinitionSettingsFile {
    id: string;
    label: string;
    [key: string]: unknown;
}

interface ModelSourceSettingsFile {
    label?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    models?: ModelDefinitionSettingsFile[];
    [key: string]: unknown;
}

export interface PillarSettingsFile {
    sources?: Partial<Record<LLMProviderName, ModelSourceSettingsFile>> & {
        [key: string]: unknown;
    };
    models?: {
        primary?: ModelTargetSettingsFile;
        fast?: ModelTargetSettingsFile;
        [key: string]: unknown;
    };
    permissions?: PermissionSettingsFile;
    hooks?: HooksSettingsFile;
    memory?: MemorySettingsFile;
    checkpointing?: CheckpointingSettingsFile;
    sandbox?: SandboxSettingsFile;
    [key: string]: unknown;
}

export interface LoadedSettingsDocument {
    source: SettingsFileSource;
    path: string;
    value: PillarSettingsFile;
}

export interface SettingsIssue {
    source: SettingsFileSource;
    path: string;
    field?: string;
    severity: "warning" | "error";
    message: string;
}

export interface ResolvedPillarSettings {
    sources: Record<LLMProviderName, ModelSourceSettings>;
    models: {
        primary: ModelTargetSettings;
        fast: ModelTargetSettings;
    };
    permissions: {
        defaultMode: PermissionMode;
        rules: PermissionRules;
    };
    hooks: ResolvedHookSettings;
    memory: {
        enabled: boolean;
        autoExtract: boolean;
    };
    checkpointing: {
        enabled: boolean;
    };
    sandbox: {
        enabled: boolean;
        filesystem: {
            allowWrite: string[];
            denyRead: string[];
            denyWrite: string[];
        };
        network: {
            allowedDomains: string[];
            allowLocalBinding: boolean;
        };
    };
}

export interface SettingsOrigins {
    primaryModel: SettingsValueSource;
    primarySource: SettingsValueSource;
    fastModel: SettingsValueSource;
    fastSource: SettingsValueSource;
    permissionMode: SettingsValueSource;
    memoryEnabled: SettingsValueSource;
    memoryAutoExtract: SettingsValueSource;
    checkpointingEnabled: SettingsValueSource;
    sandboxEnabled: SettingsValueSource;
}

export interface LoadedPillarSettings {
    values: ResolvedPillarSettings;
    origins: SettingsOrigins;
    documents: readonly LoadedSettingsDocument[];
    issues: readonly SettingsIssue[];
}

export interface PillarSettingsOverrides {
    model?: string;
    source?: LLMProviderName;
}
