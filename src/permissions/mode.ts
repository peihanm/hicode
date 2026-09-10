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
    ask: "工作区内读写和普通命令直接执行；联网及工作区外修改需要你批准。",
    "auto-review": "额外权限由独立 Agent 审核；需要你的决定时再询问。",
    "full-access": "按当前系统账户访问文件和网络，不再逐次确认额外访问。",
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
