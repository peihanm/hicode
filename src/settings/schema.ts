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
const permissionRuleListSchema = z.array(z.string().trim().min(1).refine(value =>
    !["list_files", "glob", "grep"].includes(parsePermissionRule(value).toolName),
    "list_files, glob and grep tools were removed. Configure Bash command rules and read_file/Sandbox file restrictions explicitly; old rules are not ignored or migrated."
).refine(value => {
    const rule = parsePermissionRule(value);
    const declaredName = value.split("(")[0]!;
    if (isFilePermissionTool(declaredName) && declaredName !== rule.toolName) return false;
    return !isFilePermissionTool(rule.toolName) || rule.content === undefined || validateFilePattern(rule.content);
}, "File permission content must be a path glob; JSON, ~ and Bash-prefix syntax are not accepted"));

function settingsSchema(strict: boolean): z.ZodType<HiCodeSettingsFile> {
    const object = <T extends z.ZodRawShape>(shape: T) => strict ? z.object(shape).strict() : z.object(shape).passthrough();
    const target = object({model: z.string().trim().min(1).optional(), source: configuredLLMProviderSchema.optional()});
    const model = object({id: z.string().trim().min(1).max(200), label: z.string().trim().min(1).max(200), imageInput: z.boolean().optional()});
    const source = object({
        label: z.string().trim().min(1).max(100).optional(),
        apiKeyEnv: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
        baseUrl: z.string().url().optional(),
        models: z.array(model).max(100).optional(),
    });
    return object({
        context: contextSettingsFileSchema.optional(),
        sources: object(Object.fromEntries(LLM_PROVIDER_NAMES.map(name => [name, source.optional()]))).optional(),
        models: object({
            reviewer: z.object({model: z.string().trim().min(1), source: configuredLLMProviderSchema}).strict().optional(),
            primary: target.optional(), fast: target.optional(),
        }).optional(),
        permissions: object({
            defaultMode: permissionModeSchema.optional(),
            additionalDirectories: z.array(z.string().trim().min(1)).optional(),
            allow: permissionRuleListSchema.optional(), ask: permissionRuleListSchema.optional(), deny: permissionRuleListSchema.optional(),
        }).optional(),
        hooks: hooksSettingsFileSchema.optional(),
        memory: object({enabled: z.boolean().optional(), autoExtract: z.boolean().optional()}).optional(),
        sandbox: object({
            enabled: z.never({invalid_type_error: "sandbox.enabled was removed; use permissions.defaultMode to select ask, auto-review or full-access"}).optional(),
            filesystem: object({denyRead: z.array(z.string().trim().min(1)).optional(), denyWrite: z.array(z.string().trim().min(1)).optional()}).optional(),
            network: object({
                mode: z.enum(["restricted", "open"]).optional(),
                allowedDomains: z.array(z.string().trim().min(1)).optional(), allowLocalBinding: z.boolean().optional(),
            }).optional(),
        }).optional(),
    });
}

export const hicodeSettingsFileSchema = settingsSchema(false);
export const hicodeHostSettingsSchema = settingsSchema(true);
