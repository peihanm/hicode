import {Box, Text} from "ink";
import stringWidth from "string-width";
import type {PermissionMode} from "../../permissions/index.js";
import {getPermissionModeShortLabel} from "../../permissions/index.js";
import type {CollaborationMode} from "../../collaboration/index.js";
import {COLORS} from "../theme.js";
import type {UITokenInfo} from "../turn/eventStore.js";
import type {SandboxStatus} from "../../sandbox/index.js";
import type {RunningTaskSummary} from "../../tasks/index.js";
import {useTerminalWidth} from "../terminalSize.js";

function getBackgroundTaskLabel(
    summary: RunningTaskSummary | undefined
): string | undefined {
    if (!summary || summary.total === 0) return undefined;
    return `后台 ${summary.total} · /tasks`;
}

// 两行底部 chrome：第一行保留完整运行上下文，第二行保留常用快捷键说明。
export function StatusBar({
                              cwd,
                              model,
                              permissionMode,
                              collaborationMode,
                              tokenCount,
                              percentUsed,
                              warning,
                              tokenStatus,
                              mcpConnected = 0,
                              mcpTotal = 0,
                              sandboxStatus,
                              backgroundTasks,
                          }: {
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    tokenCount: number;
    percentUsed: number; // 0-1
    warning: boolean;
    tokenStatus: UITokenInfo["status"];
    mcpConnected?: number;
    mcpTotal?: number;
    sandboxStatus?: SandboxStatus;
    backgroundTasks?: RunningTaskSummary;
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
            : permissionMode === "readOnly"
                ? COLORS.warning
                : COLORS.status;
    const tokenLabel =
        tokenStatus === "unavailable"
            ? "new session"
            : `${tokenStatus === "estimated" ? "~" : ""}${tokenCount} tokens (${tokenStatus === "estimated" ? "~" : ""}${pct}%)`;
    const modeLabel = getPermissionModeShortLabel(permissionMode);
    const showPermissionMode = permissionMode !== "default";
    const collaborationLabel = collaborationMode === "plan" ? "Plan" : undefined;
    const backgroundTaskLabel = getBackgroundTaskLabel(backgroundTasks);
    const runtimeDetails = [
        ...(mcpTotal > 0 ? [`MCP ${mcpConnected}/${mcpTotal}`] : []),
        ...(sandboxStatus?.kind === "unavailable"
            ? ["Sandbox unavailable · /sandbox"]
            : []),
        ...(backgroundTaskLabel ? [backgroundTaskLabel] : []),
    ];
    const firstPlain = [
        model,
        cwd,
        ...(showPermissionMode ? [modeLabel] : []),
        ...(collaborationLabel ? [collaborationLabel] : []),
        tokenLabel,
        ...runtimeDetails,
    ].join(" | ");
    const shortcuts =
        "? for shortcuts · shift+tab Build/Plan · ctrl+o transcript · ctrl+t toggle todos";
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
                {collaborationLabel && (
                    <>
                        <Text> | </Text>
                        <Text color={COLORS.warning}>{collaborationLabel}</Text>
                    </>
                )}
                <Text> | </Text>
                <Text color={tokenColor}>{tokenLabel}</Text>
                {mcpTotal > 0 && (
                    <Text color={mcpConnected === mcpTotal ? COLORS.surfaceText : COLORS.warning}>
                        {` | MCP ${mcpConnected}/${mcpTotal}`}
                    </Text>
                )}
                {sandboxStatus?.kind === "unavailable" && (
                    <Text color={COLORS.error}>
                        {" | Sandbox unavailable · /sandbox"}
                    </Text>
                )}
                {backgroundTaskLabel && (
                    <Text color={COLORS.surfaceText}>{` | ${backgroundTaskLabel}`}</Text>
                )}
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
