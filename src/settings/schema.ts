import {z} from "zod";
import {contextSettingsFileSchema} from "../context/config.js";
import type {HiCodeSettingsFile} from "./types.js";
import {hooksSettingsFileSchema} from "../hooks/schema.js";
import {LLM_PROVIDER_NAMES} from "../llm/providerRegistry.js";
import {isFilePermissionTool, validateFilePattern} from "../permissions/filePattern.js";
import {parsePermissionRule} from "../permissions/rules.js";

const permissionModeSchema = z.enum([
    "ask",
    "auto-review",
    "full-access",
]);

const configuredLLMProviderSchema = z.enum(LLM_PROVIDER_NAMES);
const modelDefinitionShape = {
        id: z.string().trim().min(1).max(200),
        label: z.string().trim().min(1).max(200),
    };
const modelDefinitionSchema = z
    .object(modelDefinitionShape)
    .passthrough();
const strictModelDefinitionSchema = z.object(modelDefinitionShape).strict();
const modelSourceShape = {
    label: z.string().trim().min(1).max(100).optional(),
    apiKeyEnv: z
        .string()
        .trim()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
    baseUrl: z.string().url().optional(),
};
const modelSourceSchema = z
    .object({
        ...modelSourceShape,
        models: z.array(modelDefinitionSchema).max(100).optional(),
    })
    .passthrough();
const strictModelSourceSchema = z.object({
    ...modelSourceShape,
    models: z.array(strictModelDefinitionSchema).max(100).optional(),
}).strict();

const permissionRuleListSchema = z.array(z.string().trim().min(1).refine(value =>
    !["list_files", "glob", "grep"].includes(parsePermissionRule(value).toolName),
    "list_files, glob and grep tools were removed. Configure Bash command rules and read_file/Sandbox file restrictions explicitly; old rules are not ignored or migrated."
).refine(value => {
    const rule = parsePermissionRule(value);
    const declaredName = value.split("(")[0]!;
    if (isFilePermissionTool(declaredName) && declaredName !== rule.toolName) return false;
    return !isFilePermissionTool(rule.toolName) || rule.content === undefined || validateFilePattern(rule.content);
}, "File permission content must be a path glob; JSON, ~ and Bash-prefix syntax are not accepted"));

export const hicodeSettingsFileSchema: z.ZodType<HiCodeSettingsFile> = z
    .object({
        context: contextSettingsFileSchema.optional(),
        sources: z
            .object(Object.fromEntries(
                LLM_PROVIDER_NAMES.map((name) => [name, modelSourceSchema.optional()])
            ))
            .passthrough()
            .optional(),
        models: z
            .object({
                reviewer: z.object({model: z.string().trim().min(1), source: configuredLLMProviderSchema}).strict().optional(),
                primary: z
                    .object({
                        model: z.string().trim().min(1).optional(),
                        source: configuredLLMProviderSchema.optional(),
                    })
                    .passthrough()
                    .optional(),
                fast: z
                    .object({
                        model: z.string().trim().min(1).optional(),
                        source: configuredLLMProviderSchema.optional(),
                    })
                    .passthrough()
                    .optional(),
            })
            .passthrough()
            .optional(),
        permissions: z
            .object({
                defaultMode: permissionModeSchema.optional(),
                additionalDirectories: z.array(z.string().trim().min(1)).optional(),
                allow: permissionRuleListSchema.optional(),
                ask: permissionRuleListSchema.optional(),
                deny: permissionRuleListSchema.optional(),
            })
            .passthrough()
            .optional(),
        hooks: hooksSettingsFileSchema.optional(),
        memory: z
            .object({
                enabled: z.boolean().optional(),
                autoExtract: z.boolean().optional(),
            })
            .passthrough()
            .optional(),
        sandbox: z
            .object({
                enabled: z.never({invalid_type_error: "sandbox.enabled was removed; use permissions.defaultMode to select ask, auto-review or full-access"}).optional(),
                filesystem: z
                    .object({
                        denyRead: z.array(z.string().trim().min(1)).optional(),
                        denyWrite: z.array(z.string().trim().min(1)).optional(),
                    })
                    .passthrough()
                    .optional(),
                network: z
                    .object({
                        mode: z.enum(["restricted", "open"]).optional(),
                        allowedDomains: z.array(z.string().trim().min(1)).optional(),
                        allowLocalBinding: z.boolean().optional(),
                    })
                    .passthrough()
                    .optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();

/** Host values are an API boundary, so every object is strict. */
export const hicodeHostSettingsSchema: z.ZodType<HiCodeSettingsFile> = z
    .object({
        context: contextSettingsFileSchema.optional(),
        sources: z
            .object(Object.fromEntries(
                LLM_PROVIDER_NAMES.map((name) => [name, strictModelSourceSchema.optional()])
            ))
            .strict()
            .optional(),
        models: z
            .object({
                reviewer: z.object({model: z.string().trim().min(1), source: configuredLLMProviderSchema}).strict().optional(),
                primary: z.object({
                    model: z.string().trim().min(1).optional(),
                    source: configuredLLMProviderSchema.optional(),
                }).strict().optional(),
                fast: z.object({
                    model: z.string().trim().min(1).optional(),
                    source: configuredLLMProviderSchema.optional(),
                }).strict().optional(),
            })
            .strict()
            .optional(),
        permissions: z
            .object({
                defaultMode: permissionModeSchema.optional(),
                additionalDirectories: z.array(z.string().trim().min(1)).optional(),
                allow: permissionRuleListSchema.optional(),
                ask: permissionRuleListSchema.optional(),
                deny: permissionRuleListSchema.optional(),
            })
            .strict()
            .optional(),
        hooks: hooksSettingsFileSchema.optional(),
        memory: z.object({
            enabled: z.boolean().optional(),
            autoExtract: z.boolean().optional(),
        }).strict().optional(),
        sandbox: z
            .object({
                enabled: z.never({invalid_type_error: "sandbox.enabled was removed; use permissions.defaultMode to select ask, auto-review or full-access"}).optional(),
                filesystem: z.object({
                    denyRead: z.array(z.string().trim().min(1)).optional(),
                    denyWrite: z.array(z.string().trim().min(1)).optional(),
                }).strict().optional(),
                network: z.object({
                    mode: z.enum(["restricted", "open"]).optional(),
                    allowedDomains: z.array(z.string().trim().min(1)).optional(),
                    allowLocalBinding: z.boolean().optional(),
                }).strict().optional(),
            })
            .strict()
            .optional(),
    })
    .strict();
