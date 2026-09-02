import type {PermissionMode} from "./types.js";

const PERMISSION_MODE_SET = new Set<PermissionMode>([
    "default",
    "readOnly",
    "bypassPermissions",
]);

const SHORT_LABELS: Record<PermissionMode, string> = {
    default: "Default",
    readOnly: "Read Only",
    bypassPermissions: "Bypass",
};

const DESCRIPTIONS: Record<PermissionMode, string> = {
    default: "工作区文件与已就绪 Sandbox 内普通 Bash 自动放行，其余按规则确认。",
    readOnly: "只读操作自动放行，写入或非只读命令需要确认。",
    bypassPermissions: "高权限模式；不绕过 deny/ask 规则和必须用户交互的工具。",
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
