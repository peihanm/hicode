import {createHash} from "node:crypto";
import type {HookEvent, HookSettings, HookTrustSummary, ResolvedHookMatcher, ResolvedHookSettings} from "./types.js";
import {HOOK_EVENTS} from "./types.js";

export function hookHandler(hook: HookSettings): string {
    return hook.command ?? JSON.stringify([hook.executable, ...hook.args]);
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
        ...(hook.command !== undefined
            ? {command: hook.command, shell: hook.shell ?? "bash" as const}
            : {executable: hook.executable, args: hook.args}),
    };
    return {...value, hookId: createHash("sha256").update(JSON.stringify(value)).digest("hex")};
}

const SIMPLE_ALTERNATIVES = /^[A-Za-z0-9_:-]+(?:\|[A-Za-z0-9_:-]+)*$/;

export function isValidHookMatcher(matcher: string): boolean {
    if (matcher === "*" || SIMPLE_ALTERNATIVES.test(matcher)) return true;
    try {
        new RegExp(matcher);
        return true;
    } catch {
        return false;
    }
}

/** Simple names and a|b match exactly; compile regex only when metacharacters are present. The query is bounded event metadata, not command output or large user text. */
export function matchesHookMatcher(
    query: string | undefined,
    matcher: string | undefined
): boolean {
    if (query === undefined) return true;
    if (!matcher || matcher === "*") return true;
    if (SIMPLE_ALTERNATIVES.test(matcher)) {
        return matcher.split("|").includes(query);
    }
    if (!isValidHookMatcher(matcher)) return false;
    return new RegExp(matcher).test(query);
}
