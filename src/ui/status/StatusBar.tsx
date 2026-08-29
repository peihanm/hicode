import {Box, Text} from "ink";
import stringWidth from "string-width";
import type {PermissionMode} from "../../permissions/index.js";
import {getPermissionModeShortLabel} from "../../permissions/index.js";
import {COLORS} from "../theme.js";
import type {UITokenInfo} from "../turn/eventStore.js";
import type {SandboxStatus} from "../../sandbox/index.js";
import {useTerminalWidth} from "../terminalSize.js";

// 两行底部 chrome：第一行保留完整运行上下文，第二行保留常用快捷键说明。
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
    const width = Math.max(1, useTerminalWidth() - 1);
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
    const tokenLabel =
        tokenStatus === "unavailable"
            ? "new session"
            : `${tokenStatus === "estimated" ? "~" : ""}${tokenCount} tokens (${tokenStatus === "estimated" ? "~" : ""}${pct}%)`;
    const modeLabel = getPermissionModeShortLabel(permissionMode);
    const showPermissionMode = permissionMode !== "default";
    const runtimeDetails = [
        ...(mcpTotal > 0 ? [`MCP ${mcpConnected}/${mcpTotal}`] : []),
        ...(sandboxStatus && sandboxStatus.kind !== "disabled"
            ? [sandboxStatus.kind === "ready" ? "Sandbox" : "Sandbox unavailable"]
            : []),
        ...(taskRunning ? ["Tasks running"] : []),
    ];
    const firstPlain = [
        model,
        cwd,
        ...(showPermissionMode ? [modeLabel] : []),
        tokenLabel,
        ...runtimeDetails,
    ].join(" | ");
    const shortcuts =
        "? for shortcuts · shift+tab switch mode · ctrl+o transcript · ctrl+t toggle todos · esc to cancel";
    const firstPadding = " ".repeat(Math.max(0, width - stringWidth(firstPlain) - 1));
    const shortcutPadding = " ".repeat(Math.max(0, width - stringWidth(shortcuts) - 1));

    return (
        <Box flexDirection="column" width={width}>
            <Text
                backgroundColor={COLORS.surface}
                color={COLORS.surfaceText}
                wrap="truncate-end"
            >
                {" "}<Text color={COLORS.status}>{model}</Text>
                <Text> | </Text>
                <Text color={COLORS.status}>{cwd}</Text>
                {showPermissionMode && (
                    <>
                        <Text> | </Text>
                        <Text color={modeColor}>{modeLabel}</Text>
                    </>
                )}
                <Text> | </Text>
                <Text color={tokenColor}>{tokenLabel}</Text>
                {mcpTotal > 0 && (
                    <Text color={mcpConnected === mcpTotal ? COLORS.surfaceText : COLORS.warning}>
                        {` | MCP ${mcpConnected}/${mcpTotal}`}
                    </Text>
                )}
                {sandboxStatus && sandboxStatus.kind !== "disabled" && (
                    <Text color={sandboxStatus.kind === "ready" ? COLORS.surfaceText : COLORS.error}>
                        {sandboxStatus.kind === "ready" ? " | Sandbox" : " | Sandbox unavailable"}
                    </Text>
                )}
                {taskRunning && <Text color={COLORS.surfaceText}> | Tasks running</Text>}
                {firstPadding}
            </Text>
            <Text
                backgroundColor={COLORS.surface}
                color={COLORS.surfaceText}
                wrap="truncate-end"
            >
                {" "}<Text color={COLORS.accent}>?</Text>{shortcuts.slice(1)}
                {shortcutPadding}
            </Text>
        </Box>
    );
}
