import type {ContextSettings} from "../context/config.js";
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


interface SandboxSettingsFile {
    filesystem?: {
        denyRead?: string[];
        denyWrite?: string[];
    };
    network?: {
        mode?: "restricted" | "open";
        allowedDomains?: string[];
        allowLocalBinding?: boolean;
    };
}

interface ModelDefinitionSettings {
    id: string;
    label: string;
    imageInput?: boolean;
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
    model: string;
    label: string;
}

interface ModelTargetSettingsFile {
    source?: LLMProviderName;
    model?: string;
}

interface ModelSourceSettingsFile {
    label?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    models?: ModelDefinitionSettings[];
}

export interface HiCodeSettingsFile {
    context?: Partial<ContextSettings>;
    sources?: Partial<Record<LLMProviderName, ModelSourceSettingsFile>>;
    models?: {
        reviewer?: ModelTargetSettingsFile;
        primary?: ModelTargetSettingsFile;
        fast?: ModelTargetSettingsFile;
    };
    permissions?: PermissionSettingsFile;
    hooks?: HooksSettingsFile;
    memory?: MemorySettingsFile;
    sandbox?: SandboxSettingsFile;
}

export type LoadedSettingsDocument =
    | {
        source: SettingsFileSource;
        path: string;
        value: HiCodeSettingsFile;
    }
    | {
        source: "host";
        id: string;
        value: HiCodeSettingsFile;
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

export interface ResolvedHiCodeSettings {
    context: ContextSettings;
    sources: Record<LLMProviderName, ModelSourceSettings>;
    models: {
        reviewer?: ModelTargetSettings;
        primary: ModelTargetSettings;
        fast?: ModelTargetSettings;
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
    sandbox: {
        filesystem: {
            denyRead: string[];
            denyWrite: string[];
        };
        network: {
            mode: "restricted" | "open";
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
}

export interface LoadedHiCodeSettings {
    values: ResolvedHiCodeSettings;
    origins: SettingsOrigins;
    documents: readonly LoadedSettingsDocument[];
    issues: readonly SettingsIssue[];
}

export interface HiCodeSettingsOverrides {
    model?: string;
    source?: LLMProviderName;
}
