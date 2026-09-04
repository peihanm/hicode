import type {LLMProviderName} from "../llm/providerRegistry.js";
import type {PermissionMode, PermissionRules,} from "../permissions/types.js";
import type {HooksSettingsFile, ResolvedHookSettings,} from "../hooks/types.js";

export type SettingsFileSource = "user" | "project" | "local";
type SettingsValueSource =
    | "default"
    | SettingsFileSource
    | "host"
    | "cli";

interface PermissionSettingsFile {
    defaultMode?: PermissionMode;
    additionalDirectories?: string[];
    allow?: string[];
    ask?: string[];
    deny?: string[];
}

interface MemorySettingsFile {
    enabled?: boolean;
    autoExtract?: boolean;
}

interface CheckpointingSettingsFile {
    enabled?: boolean;
}

interface SandboxSettingsFile {
    enabled?: boolean;
    filesystem?: {
        denyRead?: string[];
        denyWrite?: string[];
    };
    network?: {
        allowedDomains?: string[];
        allowLocalBinding?: boolean;
    };
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
}

interface ModelDefinitionSettingsFile {
    id: string;
    label: string;
}

interface ModelSourceSettingsFile {
    label?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    models?: ModelDefinitionSettingsFile[];
}

export interface PillarSettingsFile {
    sources?: Partial<Record<LLMProviderName, ModelSourceSettingsFile>>;
    models?: {
        primary?: ModelTargetSettingsFile;
        fast?: ModelTargetSettingsFile;
    };
    permissions?: PermissionSettingsFile;
    hooks?: HooksSettingsFile;
    memory?: MemorySettingsFile;
    checkpointing?: CheckpointingSettingsFile;
    sandbox?: SandboxSettingsFile;
}

export type LoadedSettingsDocument =
    | {
        source: SettingsFileSource;
        path: string;
        value: PillarSettingsFile;
    }
    | {
        source: "host";
        id: string;
        value: PillarSettingsFile;
    };

interface SettingsIssueDetails {
    field?: string;
    severity: "warning" | "error";
    message: string;
}

export type SettingsIssue = SettingsIssueDetails & (
    | {source: SettingsFileSource; path: string}
    | {source: "host"; id: string}
);

export interface ResolvedPillarSettings {
    sources: Record<LLMProviderName, ModelSourceSettings>;
    models: {
        primary: ModelTargetSettings;
        fast: ModelTargetSettings;
    };
    permissions: {
        defaultMode: PermissionMode;
        additionalDirectories: string[];
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
