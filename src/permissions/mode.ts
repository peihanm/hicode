import type {PermissionMode} from "./types.js";

const PERMISSION_MODES: readonly PermissionMode[] = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
];

const PERMISSION_MODE_SET = new Set<PermissionMode>(PERMISSION_MODES);

const CYCLE: PermissionMode[] = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
];

const SHORT_LABELS: Record<PermissionMode, string> = {
    default: "Default",
    acceptEdits: "Accept",
    plan: "Plan",
    bypassPermissions: "Bypass",
    dontAsk: "No Ask",
};

const DESCRIPTIONS: Record<PermissionMode, string> = {
    default: "只读工具自动放行，写操作需要确认。",
    acceptEdits: "文件编辑在工作目录内自动放行，其他写操作仍按规则确认。",
    plan: "规划模式；只读探索自动放行，写操作需要用户批准。",
    bypassPermissions: "高权限模式；不绕过 deny/ask 规则和必须用户交互的工具。",
    dontAsk: "不弹确认；所有需要确认的操作直接拒绝。",
};

const ALIASES: Record<string, PermissionMode> = {
    default: "default",
    normal: "default",
    accept: "acceptEdits",
    acceptedits: "acceptEdits",
    "accept-edits": "acceptEdits",
    plan: "plan",
    bypass: "bypassPermissions",
    bypasspermissions: "bypassPermissions",
    "bypass-permissions": "bypassPermissions",
    danger: "bypassPermissions",
    dontask: "dontAsk",
    "dont-ask": "dontAsk",
    noask: "dontAsk",
    "no-ask": "dontAsk",
};

export function parsePermissionMode(value: string): PermissionMode | null {
    const normalized = value.trim().toLowerCase();
    return ALIASES[normalized] ?? null;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === "string" &&
        PERMISSION_MODE_SET.has(value as PermissionMode);
}

export function getNextPermissionMode(current: PermissionMode): PermissionMode {
    const index = CYCLE.indexOf(current);
    if (index === -1) return "default";
    return CYCLE[(index + 1) % CYCLE.length] ?? "default";
}

export function getPermissionModeShortLabel(mode: PermissionMode): string {
    return SHORT_LABELS[mode];
}

export function getPermissionModeDescription(mode: PermissionMode): string {
    return DESCRIPTIONS[mode];
}

export function listPermissionModes(): PermissionMode[] {
    return [...PERMISSION_MODES];
}
