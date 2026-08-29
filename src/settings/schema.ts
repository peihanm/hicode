import {z} from "zod";
import type {PillarSettingsFile} from "./types.js";
import {hooksSettingsFileSchema} from "../hooks/schema.js";
import {LLM_PROVIDER_NAMES} from "../llm/providerRegistry.js";

const permissionModeSchema = z.enum([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
]);

const configuredLLMProviderSchema = z.enum(LLM_PROVIDER_NAMES);

const permissionRuleListSchema = z.array(z.string().trim().min(1));

export const pillarSettingsFileSchema: z.ZodType<PillarSettingsFile> = z
    .object({
        models: z
            .object({
                primary: z
                    .object({
                        model: z.string().trim().min(1).optional(),
                        provider: configuredLLMProviderSchema.optional(),
                    })
                    .passthrough()
                    .optional(),
                fast: z
                    .object({
                        model: z.string().trim().min(1).optional(),
                        provider: configuredLLMProviderSchema.optional(),
                    })
                    .passthrough()
                    .optional(),
            })
            .passthrough()
            .optional(),
        permissions: z
            .object({
                defaultMode: permissionModeSchema.optional(),
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
        checkpointing: z
            .object({
                enabled: z.boolean().optional(),
            })
            .passthrough()
            .optional(),
        sandbox: z
            .object({
                enabled: z.boolean().optional(),
                filesystem: z
                    .object({
                        allowWrite: z.array(z.string().trim().min(1)).optional(),
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
