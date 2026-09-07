import {createHash} from "node:crypto";
import type {HookEvent, HookSettings, HookTrustSummary, ResolvedHookMatcher, ResolvedHookSettings} from "./types.js";
import {HOOK_EVENTS} from "./types.js";

export function hookHandler(hook: HookSettings): string {
    return hook.type === "prompt" ? `prompt: ${hook.prompt}`
        : hook.command ?? JSON.stringify([hook.executable, ...hook.args]);
}
export function hookDefinitions(settings: ResolvedHookSettings): HookTrustSummary[] {
    return HOOK_EVENTS.flatMap(event => settings[event].flatMap(matcher =>
        matcher.hooks.map(hook => hookDefinition(event, matcher, hook))));
}
export function hookDefinition(event: HookEvent, matcher: ResolvedHookMatcher, hook: HookSettings): HookTrustSummary {
    const value = {
        event, type: hook.type, purpose: hook.purpose,
        ...(matcher.source === "host" ? {source: "host" as const, id: matcher.id} : {source: matcher.source, path: matcher.path}),
        ...(matcher.matcher ? {matcher: matcher.matcher} : {}),
        ...(hook.if ? {condition: hook.if} : {}),
        once: hook.once ?? false,
        timeoutMs: hook.timeoutMs ?? 10000,
        dispatchTimeoutMs: matcher.timeoutMs ?? (event === "TurnEnd" ? 2000 : event === "SessionEnd" ? 1500 : 10000),
        ...(hook.type === "prompt" ? {prompt: hook.prompt} : hook.command !== undefined
            ? {command: hook.command, shell: hook.shell ?? "bash" as const}
            : {executable: hook.executable, args: hook.args}),
    };
    return {...value, hookId: createHash("sha256").update(JSON.stringify(value)).digest("hex")};
}
