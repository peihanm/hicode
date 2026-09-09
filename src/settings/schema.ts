import {z} from "zod";
import type {PillarSettingsFile} from "./types.js";
import {hooksSettingsFileSchema} from "../hooks/schema.js";
import {LLM_PROVIDER_NAMES} from "../llm/providerRegistry.js";

const permissionModeSchema = z.enum([
    "default",
    "readOnly",
    "bypassPermissions",
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

const permissionRuleListSchema = z.array(z.string().trim().min(1));

export const pillarSettingsFileSchema: z.ZodType<PillarSettingsFile> = z
    .object({
        sources: z
            .object(Object.fromEntries(
                LLM_PROVIDER_NAMES.map((name) => [name, modelSourceSchema.optional()])
            ))
            .passthrough()
            .optional(),
        models: z
            .object({
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
                enabled: z.boolean().optional(),
                filesystem: z
                    .object({
                        denyRead: z.array(z.string().trim().min(1)).optional(),
                        denyWrite: z.array(z.string().trim().min(1)).optional(),
                    })
                    .passthrough()
                    .optional(),
                network: z
                    .object({
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
export const pillarHostSettingsSchema: z.ZodType<PillarSettingsFile> = z
    .object({
        sources: z
            .object(Object.fromEntries(
                LLM_PROVIDER_NAMES.map((name) => [name, strictModelSourceSchema.optional()])
            ))
            .strict()
            .optional(),
        models: z
            .object({
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
                enabled: z.boolean().optional(),
                filesystem: z.object({
                    denyRead: z.array(z.string().trim().min(1)).optional(),
                    denyWrite: z.array(z.string().trim().min(1)).optional(),
                }).strict().optional(),
                network: z.object({
                    allowedDomains: z.array(z.string().trim().min(1)).optional(),
                    allowLocalBinding: z.boolean().optional(),
                }).strict().optional(),
            })
            .strict()
            .optional(),
    })
    .strict();
