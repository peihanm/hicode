import {z} from "zod";
import {HOOK_EVENTS, type HookEvent, type HookPurpose, type HooksSettingsFile} from "./types.js";
import {isValidHookMatcher} from "./matcher.js";

const handlerFields = {
    purpose: z.enum(["control", "observe"]),
    if: z.string().trim().min(1).max(500).optional(),
    once: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
};
const hookSettingsSchema = z.union([
    z.object({...handlerFields, type: z.literal("command"),
        command: z.string().trim().min(1).max(20_000),
        shell: z.enum(["bash", "powershell"]).optional()}).strict(),
    z.object({...handlerFields, type: z.literal("command"),
        executable: z.string().min(1).max(16_384).refine(value => !value.includes("\0")),
        args: z.array(z.string().max(20_000).refine(value => !value.includes("\0"))).max(100)}).strict(),
    z.object({...handlerFields, type: z.literal("prompt"), prompt: z.string().trim().min(1).max(20_000)}).strict(),
]);
const hookMatcherSettingsSchema = z.object({
    matcher: z.string().trim().min(1).max(200).refine(isValidHookMatcher,
        "matcher must be a full name, a|b, *, or a valid regex").optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    hooks: z.array(hookSettingsSchema).min(1).max(20),
}).strict();
const shape = Object.fromEntries(HOOK_EVENTS.map(event => [event,
    z.array(hookMatcherSettingsSchema).max(50).optional()])) as Record<HookEvent, z.ZodOptional<z.ZodArray<typeof hookMatcherSettingsSchema>>>;
export const hooksSettingsFileSchema: z.ZodType<HooksSettingsFile> = z.object(shape).strict().superRefine((settings, ctx) => {
    for (const event of HOOK_EVENTS) settings[event]?.forEach((matcher, mi) => {
        if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) && matcher.matcher?.split("|").some(name => ["list_files", "glob", "grep"].includes(name.replace(/^\^|\$$/g, "")))) {
            ctx.addIssue({code: "custom", path: [event, mi, "matcher"], message: "Search tools were removed; search commands now emit Bash events. Update this Hook matcher explicitly."});
        }
        const cleanup = event === "TurnEnd" || event === "SessionEnd";
        if (matcher.timeoutMs && matcher.timeoutMs > (event === "TurnEnd" ? 5000 : event === "SessionEnd" ? 1500 : 30000)) {
            ctx.addIssue({code: "custom", path: [event, mi, "timeoutMs"], message: "Event deadline exceeds the limit allowed for this lifecycle"});
        }
        matcher.hooks.forEach((hook, hi) => {
            const path = [event, mi, "hooks", hi];
            if (hook.if && !["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event))
                ctx.addIssue({code: "custom", path: [...path, "if"], message: "if is only allowed for Tool events"});
            if (hook.purpose === "control" && !["PreToolUse", "UserPromptSubmit", "Stop"].includes(event))
                ctx.addIssue({code: "custom", path: [...path, "purpose"], message: `${event} only allows observe`});
            if (cleanup && hook.type === "prompt")
                ctx.addIssue({code: "custom", path: [...path, "type"], message: `${event} does not allow Prompt handlers`});
        });
    });
});

export interface HookJSONOutput {
    decision?: "pass" | "block" | "rewrite" | "accept" | "continue";
    reason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    userMessage?: string;
}
const common = {userMessage: z.string().max(2000).optional()};
const contextual = {...common, additionalContext: z.string().max(10000).optional()};
const reason = z.string().trim().min(1).max(2000);
/** The same event-specific schema validates Command JSON and defines the Prompt tool. */
export function hookOutputSchema(event: HookEvent, purpose: HookPurpose): z.ZodType<HookJSONOutput> {
    if (purpose === "observe") return z.object(
        ["TurnEnd", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"].includes(event) ? common : contextual
    ).strict();
    if (event === "Stop") return z.discriminatedUnion("decision", [
        z.object({...common, decision: z.literal("accept")}).strict(),
        z.object({...contextual, decision: z.literal("continue"), reason}).strict(),
    ]);
    const pass = z.object({...contextual, decision: z.literal("pass")}).strict();
    const block = z.object({...contextual, decision: z.literal("block"), reason}).strict();
    if (event === "PreToolUse") return z.discriminatedUnion("decision", [pass, block,
        z.object({...contextual, decision: z.literal("rewrite"), updatedInput: z.record(z.string(), z.unknown())}).strict(),
    ]);
    if (event === "UserPromptSubmit") return z.discriminatedUnion("decision", [pass, block]);
    return z.never();
}
