// Permission-system types.
// Based on Claude Code src/types/permissions.ts:240-266.

// Tools declare permission intent through checkPermissions.
// executeTool uses that intent to request approval, execute directly or deny.
import type {DirectoryAccessRequest, DirectoryGrantScope} from "./directoryAccess.js";

export type PermissionPromptPresentation =
    | {
        kind: "network_access";
        host: string;
        port: number;
    }
    | ({kind: "filesystem_access"} & DirectoryAccessRequest);

export type PermissionResult =
    | { behavior: "allow" } // Allow without asking the user.
    | { behavior: "deny"; message: string } // Deny without executing.
    | {
        behavior: "ask";
        message: string;
        allowPersistent?: boolean;
        presentation?: PermissionPromptPresentation;
    } // Ask the user.
    | { behavior: "passthrough" }; // Defer to default rules based on isReadOnly.

// Permission decision returned by canUseTool.
// When checkPermissions returns ask, the caller asks the user.
// answers carries only Host answers to original questions; it cannot replace questions or ordinary arguments.
export type PermissionDecision =
    | {
        behavior: "allow";
        answers?: Record<string, string>;
        directoryScope?: "once" | DirectoryGrantScope;
        networkScope?: "once" | "session";
    } // User approved; may include answers to the original questions.
    | { behavior: "deny"; message: string }; // User denied.

// Configuration rule types.

// Tool approval policy; separate execution boundaries enforce file/network isolation.
export type PermissionMode = "ask" | "auto-review" | "full-access"; // Automatically approve ordinary operations, still subject to deny/ask, user interaction and Sandbox limits.

// Whether Host supports permission interaction. never only narrows ask to deny and cannot widen access.
export type PermissionPromptPolicy = "onRequest" | "never";

// Permission rule source.
type PermissionRuleSource = "user" | "project" | "local" | "host";

// One permission rule.
// Based on Claude Code src/types/permissions.ts:67-79.
export interface PermissionRule {
    toolName: string;
    content?: string; // undefined matches the whole tool; otherwise match the argument pattern.
    source: PermissionRuleSource;
}

// Rule sets grouped by behavior.
export interface PermissionRules {
    allow: PermissionRule[];
    ask: PermissionRule[];
    deny: PermissionRule[];
}
