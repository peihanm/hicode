import {DEFAULT_LLM_PROVIDER, LLM_PROVIDER_NAMES, type LLMProviderName,} from "../llm/providerRegistry.js";
import {parsePermissionRule} from "../permissions/rules.js";
import type {PermissionMode, PermissionRule, PermissionRules,} from "../permissions/types.js";
import type {HookEvent, ResolvedHookMatcher, ResolvedHookSettings,} from "../hooks/types.js";
import type {
    LoadedPillarSettings,
    LoadedSettingsDocument,
    ModelSourceSettings,
    ModelTargetSettings,
    PillarSettingsOverrides,
    SettingsOrigins,
} from "./types.js";

export const DEFAULT_MODEL = "qwen3.8-flash";

const DEFAULT_SOURCES: Record<LLMProviderName, ModelSourceSettings> = {
    glm: {
        id: "glm",
        label: "智谱 GLM",
        apiKeyEnv: "GLM_API_KEY",
        models: [
            {id: "glm-5.2", label: "GLM 5.2"},
            {id: "glm-4.7", label: "GLM 4.7"},
        ],
    },
    qwen: {
        id: "qwen",
        label: "阿里云百炼",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        models: [
            {id: "qwen3.8-flash", label: "Qwen 3.8 Flash"},
            {id: "qwen3.8-max", label: "Qwen 3.8 Max"},
            {id: "qwen3.6-plus", label: "Qwen 3.6 Plus"},
            {id: "qwen3.6-flash", label: "Qwen 3.6 Flash"},
        ],
    },
    deepseek: {
        id: "deepseek",
        label: "DeepSeek",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [
            {id: "deepseek-v4-pro", label: "DeepSeek V4 Pro"},
            {id: "deepseek-v4-flash", label: "DeepSeek V4 Flash"},
        ],
    },
};

function cloneSources(): Record<LLMProviderName, ModelSourceSettings> {
    const sources = {} as Record<LLMProviderName, ModelSourceSettings>;
    for (const name of LLM_PROVIDER_NAMES) {
        const source = DEFAULT_SOURCES[name];
        sources[name] = {
            ...source,
            models: source.models.map((model) => ({...model})),
        };
    }
    return sources;
}

function mergeUserSources(
    documents: readonly LoadedSettingsDocument[]
): Record<LLMProviderName, ModelSourceSettings> {
    const sources = cloneSources();
    for (const document of documents) {
        if (document.source !== "user" && document.source !== "host") continue;
        for (const name of LLM_PROVIDER_NAMES) {
            const override = document.value.sources?.[name];
            if (!override || typeof override !== "object") continue;
            const current = sources[name];
            sources[name] = {
                id: name,
                label: override.label ?? current.label,
                apiKeyEnv: override.apiKeyEnv ?? current.apiKeyEnv,
                ...(override.baseUrl !== undefined
                    ? {baseUrl: override.baseUrl}
                    : current.baseUrl !== undefined
                        ? {baseUrl: current.baseUrl}
                        : {}),
                models: (override.models ?? current.models).map((model) => ({
                    id: model.id,
                    label: model.label,
                })),
            };
        }
    }
    for (const source of Object.values(sources)) {
        const ids = new Set<string>();
        for (const model of source.models) {
            if (ids.has(model.id)) {
                throw new Error(`模型来源 ${source.id} 重复定义模型 ${model.id}`);
            }
            ids.add(model.id);
        }
    }
    return sources;
}

function resolveModelTarget(
    sources: Record<LLMProviderName, ModelSourceSettings>,
    sourceName: LLMProviderName,
    modelId: string,
    slot: "primary" | "fast"
): ModelTargetSettings {
    const source = sources[sourceName];
    const model = source.models.find((candidate) => candidate.id === modelId);
    if (!model) {
        throw new Error(
            `${slot} 模型 ${sourceName}/${modelId} 未在 sources.${sourceName}.models 中定义`
        );
    }
    return {
        source: sourceName,
        provider: sourceName,
        model: model.id,
        label: model.label,
    };
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
                buckets[behavior].set(key, {...parsed, source: document.source});
            }
        }
    }
    return {
        allow: [...buckets.allow.values()],
        ask: [...buckets.ask.values()],
        deny: [...buckets.deny.values()],
    };
}

function mergeAdditionalDirectories(
    documents: readonly LoadedSettingsDocument[]
): string[] {
    const directories = new Set<string>();
    for (const document of documents) {
        for (const directory of
            document.value.permissions?.additionalDirectories ?? []) {
            directories.add(directory);
        }
    }
    return [...directories];
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
    PostToolBatch: [], Stop: [], TurnEnd: [], PreCompact: [], PostCompact: [], SubagentStart: [], SubagentStop: [],
    };
    for (const document of documents) {
        for (const [event, matchers] of Object.entries(document.value.hooks ?? {})) {
            const target = event as HookEvent;
            resolved[target].push(...(matchers ?? []).map((matcher) =>
                document.source === "host"
                    ? {...matcher, source: "host" as const, id: document.id}
                    : {
                        ...matcher,
                        source: document.source,
                        path: document.path,
                    }
            ));
        }
    }
    return resolved;
}

export function resolvePillarSettings(
    documents: readonly LoadedSettingsDocument[],
    cli: PillarSettingsOverrides = {}
): Pick<LoadedPillarSettings, "values" | "origins"> {
    const sources = mergeUserSources(documents);
    let primaryModel = DEFAULT_MODEL;
    let primarySource = DEFAULT_LLM_PROVIDER;
    let fastModel = DEFAULT_MODEL;
    let fastSource = DEFAULT_LLM_PROVIDER;
    let permissionMode: PermissionMode = "default";
    let memoryEnabled = true;
    let memoryAutoExtract = false;
    let memoryDisabled = false;
    let autoExtractDisabled = false;
    let checkpointingEnabled = true;
    let sandboxEnabled = true;
    let sandboxDenyRead = ["~/.ssh", "~/.aws", "~/.config/gcloud"];
    let sandboxDenyWrite = [".pillar", ".env"];
    let sandboxAllowedDomains: string[] = [];
    let sandboxAllowLocalBinding = true;
    const origins: SettingsOrigins = {
        primaryModel: "default",
        primarySource: "default",
        fastModel: "default",
        fastSource: "default",
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
        if (value.models?.primary?.source !== undefined) {
            primarySource = value.models.primary.source;
            origins.primarySource = document.source;
        }
        if (value.models?.fast?.model !== undefined) {
            fastModel = value.models.fast.model;
            origins.fastModel = document.source;
        }
        if (value.models?.fast?.source !== undefined) {
            fastSource = value.models.fast.source;
            origins.fastSource = document.source;
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

    if (cli.source !== undefined) {
        primarySource = cli.source;
        origins.primarySource = "cli";
    }
    if (cli.model !== undefined) {
        primaryModel = cli.model;
        origins.primaryModel = "cli";
    }

    if (
        origins.primarySource === "default" &&
        origins.primaryModel === "default" &&
        !sources[primarySource].models.some((model) => model.id === primaryModel)
    ) {
        primaryModel = sources[primarySource].models[0]?.id ?? primaryModel;
    }
    if (
        origins.fastSource === "default" &&
        origins.fastModel === "default" &&
        !sources[fastSource].models.some((model) => model.id === fastModel)
    ) {
        fastModel = sources[fastSource].models[0]?.id ?? fastModel;
    }

    return {
        values: {
            sources,
            models: {
                primary: resolveModelTarget(sources, primarySource, primaryModel, "primary"),
                fast: resolveModelTarget(sources, fastSource, fastModel, "fast"),
            },
            permissions: {
                defaultMode: permissionMode,
                additionalDirectories: mergeAdditionalDirectories(documents),
                rules: mergePermissionRules(documents),
            },
            hooks: mergeHooks(documents),
            memory: {
                enabled: memoryEnabled,
                autoExtract: memoryEnabled && memoryAutoExtract,
            },
            checkpointing: {enabled: checkpointingEnabled},
            sandbox: {
                enabled: sandboxEnabled,
                filesystem: {
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
