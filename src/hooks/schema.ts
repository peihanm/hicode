import {z} from "zod";
import {HOOK_EVENTS, type HooksSettingsFile} from "./types.js";
import {isValidHookMatcher} from "./matcher.js";

const commandHookSettingsSchema = z.object({
    type: z.literal("command"),
    command: z.string().trim().min(1).max(20_000),
    if: z.string().trim().min(1).max(500).optional(),
    shell: z.enum(["bash", "powershell"]).optional(),
    once: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
}).strict();

const promptHookSettingsSchema = z.object({
    type: z.literal("prompt"),
    prompt: z.string().trim().min(1).max(20_000),
    if: z.string().trim().min(1).max(500).optional(),
    once: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict();

const hookSettingsSchema = z.discriminatedUnion("type", [
    commandHookSettingsSchema,
    promptHookSettingsSchema,
]);

const hookMatcherSettingsSchema = z.object({
    matcher: z.string().trim().min(1).max(200).refine(
        isValidHookMatcher,
        "matcher 必须是完整名称、a|b、* 或合法正则"
    ).optional(),
    hooks: z.array(hookSettingsSchema).min(1).max(20),
}).strict();

const hookEventShape = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
        event,
        z.array(hookMatcherSettingsSchema).max(50).optional(),
    ])
) as Record<(typeof HOOK_EVENTS)[number], z.ZodOptional<z.ZodArray<typeof hookMatcherSettingsSchema>>>;

export const hooksSettingsFileSchema: z.ZodType<HooksSettingsFile> = z
    .object(hookEventShape)
    .strict()
    .superRefine((settings, context) => {
        for (const event of HOOK_EVENTS) {
            if (
                event === "PreToolUse" ||
                event === "PostToolUse" ||
                event === "PostToolUseFailure"
            ) continue;
            settings[event]?.forEach((matcher, matcherIndex) => {
                matcher.hooks.forEach((hook, hookIndex) => {
                    if (!hook.if) return;
                    context.addIssue({
                        code: "custom",
                        path: [event, matcherIndex, "hooks", hookIndex, "if"],
                        message: "if 只允许用于 Tool 事件",
                    });
                });
            });
        }
    });

export const hookJSONOutputSchema = z.object({
    decision: z.literal("block").optional(),
    reason: z.string().max(2_000).optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().max(10_000).optional(),
}).strict();

export type HookJSONOutput = z.infer<typeof hookJSONOutputSchema>;
