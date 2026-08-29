import {Box, Text} from "ink";
import type {PermissionMode} from "../../permissions/index.js";
import {getPermissionModeShortLabel} from "../../permissions/index.js";
import {COLORS} from "../theme.js";
import type {UITokenInfo} from "../turn/eventStore.js";
import type {SandboxStatus} from "../../sandbox/index.js";

// 底部状态行：model/cwd/token + 快捷键提示
// 仿 codebuddy 底部
export function StatusBar({
                              cwd,
                              model,
                              permissionMode,
                              tokenCount,
                              percentUsed,
                              warning,
                              tokenStatus,
                              mcpConnected = 0,
                              mcpTotal = 0,
                              sandboxStatus,
                              taskRunning = false,
                          }: {
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    tokenCount: number;
    percentUsed: number; // 0-1
    warning: boolean;
    tokenStatus: UITokenInfo["status"];
    mcpConnected?: number;
    mcpTotal?: number;
    sandboxStatus?: SandboxStatus;
    taskRunning?: boolean;
}) {
    // token 颜色：warning 红色，>60% 黄色，其他灰色
    const tokenColor = warning
        ? COLORS.error
        : percentUsed > 0.6
            ? COLORS.warning
            : COLORS.dim;
    const pct = Math.round(percentUsed * 100);
    const modeColor =
        permissionMode === "bypassPermissions"
            ? COLORS.error
            : permissionMode === "plan"
                ? COLORS.warning
                : permissionMode === "dontAsk"
                    ? COLORS.dim
                    : COLORS.status;
    const showPermissionMode = permissionMode !== "default";
    const tokenLabel =
        tokenStatus === "unavailable"
            ? "new session"
            : `${tokenStatus === "estimated" ? "~" : ""}${tokenCount} tokens (${tokenStatus === "estimated" ? "~" : ""}${pct}%)`;

    return (
        <Box flexDirection="column">
            <Box>
                <Text color={COLORS.status}>{model}</Text>
                <Text color={COLORS.dim}> | </Text>
                <Text color={COLORS.status}>{cwd}</Text>
                {showPermissionMode && (
                    <>
                        <Text color={COLORS.dim}> | </Text>
                        <Text color={modeColor}>
                            {getPermissionModeShortLabel(permissionMode)}
                        </Text>
                    </>
                )}
                <Text color={COLORS.dim}> | </Text>
                <Text color={tokenColor}>{tokenLabel}</Text>
                {mcpTotal > 0 && (
                    <>
                        <Text color={COLORS.dim}> | </Text>
                        <Text color={mcpConnected === mcpTotal ? COLORS.status : COLORS.warning}>
                            MCP {mcpConnected}/{mcpTotal}
                        </Text>
                    </>
                )}
                {sandboxStatus && sandboxStatus.kind !== "disabled" && (
                    <>
                        <Text color={COLORS.dim}> | </Text>
                        <Text
                            color={
                                sandboxStatus.kind === "ready"
                                    ? COLORS.status
                                    : COLORS.error
                            }
                        >
                            {sandboxStatus.kind === "ready"
                                ? "Sandbox"
                                : "Sandbox unavailable"}
                        </Text>
                    </>
                )}
                {taskRunning && (
                    <>
                        <Text color={COLORS.dim}> | </Text>
                        <Text color={COLORS.status}>Tasks running</Text>
                    </>
                )}
            </Box>
            <Box>
                <Text color={COLORS.dim}>
                    ? for shortcuts · shift+tab switch mode · ctrl+o transcript · ctrl+t toggle todos · esc to cancel
                </Text>
            </Box>
        </Box>
    );
}
