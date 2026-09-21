import type {PermissionMode} from "./types.js";

const PERMISSION_MODE_SET = new Set<PermissionMode>([
    "ask",
    "auto-review",
    "full-access",
]);

const SHORT_LABELS: Record<PermissionMode, string> = {
    ask: "Ask for approval",
    "auto-review": "Approve for me",
    "full-access": "Full Access",
};

const DESCRIPTIONS: Record<PermissionMode, string> = {
    ask: "Workspace reads, edits and ordinary commands run directly; extra access requires approval. Network policy follows /sandbox settings.",
    "auto-review": "An independent Agent reviews extra access; you are asked when a decision is needed.",
    "full-access": "Access files and the network as the current OS account without confirming each additional access request.",
};

export function parsePermissionMode(value: string): PermissionMode | null {
    const candidate = value.trim();
    return isPermissionMode(candidate) ? candidate : null;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === "string" &&
        PERMISSION_MODE_SET.has(value as PermissionMode);
}

export function getPermissionModeShortLabel(mode: PermissionMode): string {
    return SHORT_LABELS[mode];
}

export function getPermissionModeDescription(mode: PermissionMode): string {
    return DESCRIPTIONS[mode];
}
