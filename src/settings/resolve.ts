import {DEFAULT_LLM_PROVIDER, type LLMProviderName,} from "../llm/providerRegistry.js";
import {parsePermissionRule} from "../permissions/rules.js";
import type {PermissionMode, PermissionRule, PermissionRules,} from "../permissions/types.js";
import type {HookEvent, ResolvedHookMatcher, ResolvedHookSettings,} from "../hooks/types.js";
import type {PillarSettingsOverrides, LoadedPillarSettings, LoadedSettingsDocument, SettingsOrigins,} from "./types.js";

export const DEFAULT_MODEL = "glm-5.2";

export interface EnvironmentSettingsOverrides {
    primary?: Partial<{provider: LLMProviderName; model: string}>;
    fast?: Partial<{provider: LLMProviderName; model: string}>;
}

function mergePermissionRules(
    documents: readonly LoadedSettingsDocument[]
): PermissionRules {
    const buckets: Record<keyof PermissionRules, Map<string, PermissionRule>> = {
        allow: new Map(),
        ask: new Map(),
        deny: new Map(),
    };
    for (const document of documents) {
        for (const behavior of ["allow", "ask", "deny"] as const) {
            for (const ruleText of document.value.permissions?.[behavior] ?? []) {
                const parsed = parsePermissionRule(ruleText);
                const key = `${parsed.toolName}\u0000${parsed.content ?? ""}`;
                buckets[behavior].set(key, {
                    ...parsed,
                    source: document.source,
                });
            }
        }
    }
    return {
        allow: [...buckets.allow.values()],
        ask: [...buckets.ask.values()],
        deny: [...buckets.deny.values()],
    };
}

function mergeHooks(
    documents: readonly LoadedSettingsDocument[]
): ResolvedHookSettings {
    const resolved: Record<HookEvent, ResolvedHookMatcher[]> = {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
        PostToolUseFailure: [],
        SessionEnd: [],
    };
    for (const document of documents) {
        for (const [event, matchers] of Object.entries(document.value.hooks ?? {})) {
            const target = event as HookEvent;
            resolved[target].push(
                ...(matchers ?? []).map((matcher) => ({
                    ...matcher,
                    source: document.source,
                    path: document.path,
                }))
            );
        }
    }
    return resolved;
}

export function resolvePillarSettings(
    documents: readonly LoadedSettingsDocument[],
    environment: EnvironmentSettingsOverrides = {},
    cli: PillarSettingsOverrides = {}
): Pick<LoadedPillarSettings, "values" | "origins"> {
    let primaryModel = DEFAULT_MODEL;
    let primaryProvider = DEFAULT_LLM_PROVIDER;
    let fastModel = "glm-4.7";
    let fastProvider = DEFAULT_LLM_PROVIDER;
    let permissionMode: PermissionMode = "default";
    let memoryEnabled = true;
    let memoryAutoExtract = true;
    let memoryDisabled = false;
    let autoExtractDisabled = false;
    let checkpointingEnabled = true;
    let sandboxEnabled = false;
    let sandboxAllowWrite = ["."];
    let sandboxDenyRead = ["~/.ssh", "~/.aws", "~/.config/gcloud"];
    let sandboxDenyWrite = [".pillar", ".env"];
    let sandboxAllowedDomains: string[] = [];
    let sandboxAllowLocalBinding = false;
    const origins: SettingsOrigins = {
        primaryModel: "default",
        primaryProvider: "default",
        fastModel: "default",
        fastProvider: "default",
        permissionMode: "default",
        memoryEnabled: "default",
        memoryAutoExtract: "default",
        checkpointingEnabled: "default",
        sandboxEnabled: "default",
    };

    for (const document of documents) {
        const value = document.value;
        if (value.models?.primary?.model !== undefined) {
            primaryModel = value.models.primary.model;
            origins.primaryModel = document.source;
        }
        if (value.models?.primary?.provider !== undefined) {
            primaryProvider = value.models.primary.provider;
            origins.primaryProvider = document.source;
        }
        if (value.models?.fast?.model !== undefined) {
            fastModel = value.models.fast.model;
            origins.fastModel = document.source;
        }
        if (value.models?.fast?.provider !== undefined) {
            fastProvider = value.models.fast.provider;
            origins.fastProvider = document.source;
        }
        const documentMode = value.permissions?.defaultMode;
        if (documentMode !== undefined) {
            permissionMode = documentMode;
            origins.permissionMode = document.source;
        }
        if (value.memory?.enabled !== undefined) {
            if (value.memory.enabled === false) {
                memoryDisabled = true;
                memoryEnabled = false;
                origins.memoryEnabled = document.source;
            } else if (!memoryDisabled) {
                memoryEnabled = true;
                origins.memoryEnabled = document.source;
            }
        }
        if (value.memory?.autoExtract !== undefined) {
            if (value.memory.autoExtract === false) {
                autoExtractDisabled = true;
                memoryAutoExtract = false;
                origins.memoryAutoExtract = document.source;
            } else if (!autoExtractDisabled) {
                memoryAutoExtract = true;
                origins.memoryAutoExtract = document.source;
            }
        }
        if (value.checkpointing?.enabled !== undefined) {
            checkpointingEnabled = value.checkpointing.enabled;
            origins.checkpointingEnabled = document.source;
        }
        if (value.sandbox?.enabled !== undefined) {
            sandboxEnabled = value.sandbox.enabled;
            origins.sandboxEnabled = document.source;
        }
        if (value.sandbox?.filesystem?.allowWrite !== undefined) {
            sandboxAllowWrite = [...value.sandbox.filesystem.allowWrite];
        }
        if (value.sandbox?.filesystem?.denyRead !== undefined) {
            sandboxDenyRead = [...value.sandbox.filesystem.denyRead];
        }
        if (value.sandbox?.filesystem?.denyWrite !== undefined) {
            sandboxDenyWrite = [...value.sandbox.filesystem.denyWrite];
        }
        if (value.sandbox?.network?.allowedDomains !== undefined) {
            sandboxAllowedDomains = [...value.sandbox.network.allowedDomains];
        }
        if (value.sandbox?.network?.allowLocalBinding !== undefined) {
            sandboxAllowLocalBinding = value.sandbox.network.allowLocalBinding;
        }
    }

    if (environment.primary?.provider !== undefined) {
        primaryProvider = environment.primary.provider;
        origins.primaryProvider = "environment";
    }
    if (environment.primary?.model !== undefined) {
        primaryModel = environment.primary.model;
        origins.primaryModel = "environment";
    }
    if (environment.fast?.provider !== undefined) {
        fastProvider = environment.fast.provider;
        origins.fastProvider = "environment";
    }
    if (environment.fast?.model !== undefined) {
        fastModel = environment.fast.model;
        origins.fastModel = "environment";
    }
    if (cli.provider !== undefined) {
        primaryProvider = cli.provider;
        origins.primaryProvider = "cli";
    }
    if (cli.model !== undefined) {
        primaryModel = cli.model;
        origins.primaryModel = "cli";
    }

    return {
        values: {
            models: {
                primary: {provider: primaryProvider, model: primaryModel},
                fast: {provider: fastProvider, model: fastModel},
            },
            permissions: {
                defaultMode: permissionMode,
                rules: mergePermissionRules(documents),
            },
            hooks: mergeHooks(documents),
            memory: {
                enabled: memoryEnabled,
                autoExtract: memoryEnabled && memoryAutoExtract,
            },
            checkpointing: {
                enabled: checkpointingEnabled,
            },
            sandbox: {
                enabled: sandboxEnabled,
                filesystem: {
                    allowWrite: sandboxAllowWrite,
                    denyRead: sandboxDenyRead,
                    denyWrite: sandboxDenyWrite,
                },
                network: {
                    allowedDomains: sandboxAllowedDomains,
                    allowLocalBinding: sandboxAllowLocalBinding,
                },
            },
        },
        origins,
    };
}
