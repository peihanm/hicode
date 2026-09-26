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
    return `Background ${summary.total} · /tasks`;
}

// Two footer rows: runtime context first, common shortcuts second.
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
                              showShortcuts = true,
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
    showShortcuts?: boolean;
}) {
    const width = Math.max(1, useTerminalWidth() - 1);
    // Token colors: red on warning, yellow above 60%, otherwise gray.
    const tokenColor = warning
        ? COLORS.error
        : percentUsed > 0.6
            ? COLORS.warning
            : COLORS.surfaceText;
    const pct = Math.round(percentUsed * 100);
    const modeColor =
        permissionMode === "full-access"
            ? COLORS.error
            : permissionMode === "auto-review"
                ? COLORS.warning
                : COLORS.status;
    const tokenLabel =
        tokenStatus === "unavailable"
            ? "new session"
            : `${tokenStatus === "estimated" ? "~" : ""}${tokenCount} tokens (${tokenStatus === "estimated" ? "~" : ""}${pct}%)`;
    const modeLabel = getPermissionModeShortLabel(permissionMode);
    const showPermissionMode = permissionMode !== "ask";
    const collaborationLabel = collaborationMode === "plan" ? "Plan" : undefined;
    const backgroundTaskLabel = getBackgroundTaskLabel(backgroundTasks);
    const showSandboxFailure = permissionMode !== "full-access" && sandboxStatus?.kind === "unavailable";
    const runtimeDetails = [
        ...(mcpTotal > 0 ? [`MCP ${mcpConnected}/${mcpTotal}`] : []),
        ...(showSandboxFailure
            ? ["Sandbox unavailable · /sandbox"]
            : []),
        ...(backgroundTaskLabel ? [backgroundTaskLabel] : []),
    ];
    const firstPlain = [
        model,
        ...(showPermissionMode ? [modeLabel] : []),
        ...(collaborationLabel ? [collaborationLabel] : []),
        cwd,
        tokenLabel,
        ...runtimeDetails,
    ].join(" | ");
    const shortcuts =
        "shift+tab Build/Plan · ctrl+o transcript";
    const firstPadding = " ".repeat(Math.max(0, width - stringWidth(firstPlain) - 1));
    const shortcutPadding = " ".repeat(Math.max(0, width - stringWidth(shortcuts) - 1));

    return (
        <Box flexDirection="column" width={width}>
            <Text
                backgroundColor={COLORS.surface}
                color={COLORS.surfaceText}
                wrap="truncate-end"
            >
                {" "}<Text color={COLORS.surfaceAccent}>{model}</Text>
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
                <Text color={COLORS.surfaceAccent}>{cwd}</Text>
                <Text> | </Text>
                <Text color={tokenColor}>{tokenLabel}</Text>
                {mcpTotal > 0 && (
                    <Text color={mcpConnected === mcpTotal ? COLORS.surfaceText : COLORS.warning}>
                        {` | MCP ${mcpConnected}/${mcpTotal}`}
                    </Text>
                )}
                {showSandboxFailure && (
                    <Text color={COLORS.error}>
                        {" | Sandbox unavailable · /sandbox"}
                    </Text>
                )}
                {backgroundTaskLabel && (
                    <Text color={COLORS.surfaceText}>{` | ${backgroundTaskLabel}`}</Text>
                )}
                {firstPadding}
            </Text>
            {showShortcuts && <Text
                backgroundColor={COLORS.surface}
                color={COLORS.surfaceText}
                wrap="truncate-end"
            >
                {" "}{shortcuts}
                {shortcutPadding}
            </Text>}
        </Box>
    );
}
