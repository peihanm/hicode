import {z} from "zod";

const fields = {
    windowTokens: z.number().int().min(4096).max(Number.MAX_SAFE_INTEGER),
    autoCompactTokenLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const schema = z.object(fields).strict();
export type ContextSettings = Readonly<z.infer<typeof schema>>;
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = Object.freeze({
    windowTokens: 500_000,
    autoCompactTokenLimit: 450_000,
});
export const contextSettingsFileSchema = schema.partial();

export function validateContextSettings(value: unknown): ContextSettings {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("Context configuration requires valid integer windowTokens and autoCompactTokenLimit");
    const settings = parsed.data;
    const reserve = outputReserve(settings.windowTokens);
    if (settings.autoCompactTokenLimit > settings.windowTokens - reserve) {
        throw new Error(`context.autoCompactTokenLimit cannot exceed the input budget of ${settings.windowTokens - reserve}(output capacity is reserved)`);
    }
    return Object.freeze(settings);
}

function outputReserve(windowTokens: number): number {
    return Math.min(20_000, Math.floor(windowTokens * 0.2));
}

interface ContextBudget {
    inputTokens: number;
    compactThreshold: number;
    compactTarget: number;
    warningThreshold: number;
}

export function getContextBudget(settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS): ContextBudget {
    const inputTokens = Math.max(1, settings.windowTokens - outputReserve(settings.windowTokens));
    const compactThreshold = Math.min(settings.autoCompactTokenLimit,
        Math.max(1, inputTokens - Math.min(13_000, Math.floor(inputTokens * 0.15))));
    return {
        inputTokens,
        compactThreshold,
        compactTarget: Math.max(1, Math.floor(Math.min(inputTokens * 0.65, compactThreshold * 0.8))),
        warningThreshold: Math.max(1, compactThreshold - 20_000),
    };
}

export function getTokenWarningState(tokenCount: number, budget: ContextBudget) {
    return {
        percentUsed: Math.min(1, tokenCount / budget.inputTokens),
        warning: tokenCount >= budget.warningThreshold,
        critical: tokenCount >= budget.compactThreshold,
    };
}
