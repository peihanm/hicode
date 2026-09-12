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
    const reserve = Math.min(20_000, Math.floor(settings.windowTokens * 0.2));
    if (settings.autoCompactTokenLimit > settings.windowTokens - reserve) {
        throw new Error(`context.autoCompactTokenLimit cannot exceed the input budget of ${settings.windowTokens - reserve}(output capacity is reserved)`);
    }
    return Object.freeze(settings);
}
