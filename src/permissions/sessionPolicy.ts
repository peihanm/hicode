import {ApprovalEpoch} from "./approval.js";
import type {PermissionMode, PermissionRules} from "./types.js";

/** Session policy is live for every actor; individual operations freeze and validate its epoch. */
export class SessionPermissionPolicy {
    private readonly listeners = new Set<() => void>();
    constructor(private mode: PermissionMode, private rules: PermissionRules, readonly epoch: ApprovalEpoch,
        private readonly allowFullAccess: boolean) {}

    getMode = (): PermissionMode => this.mode;
    getRules = (): PermissionRules => this.rules;
    setMode(mode: PermissionMode): void {
        if (mode === "full-access" && !this.allowFullAccess) throw new Error("This Host does not allow Full Access");
        if (mode === this.mode) return;
        this.epoch.invalidate();
        this.mode = mode;
        for (const listener of this.listeners) listener();
    }
    setRules(rules: PermissionRules): void {
        // Saving an additional allow from a dialog must not cancel that same approval.
        // Any removed allow or changed ask/deny invalidates pending decisions.
        const nextAllows = new Set(rules.allow.map(rule => JSON.stringify(rule)));
        if (JSON.stringify(rules.ask) !== JSON.stringify(this.rules.ask) ||
            JSON.stringify(rules.deny) !== JSON.stringify(this.rules.deny) ||
            this.rules.allow.some(rule => !nextAllows.has(JSON.stringify(rule)))) {
            this.epoch.invalidate();
        }
        this.rules = rules;
    }
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {this.listeners.delete(listener);};
    };
}
