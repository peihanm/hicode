import {useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import {getPermissionModeDescription, getPermissionModeShortLabel, type PermissionMode} from "../../permissions/index.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS: readonly PermissionMode[] = ["ask", "auto-review", "full-access"];

function fitRow(value: string, width: number): string {
    let result = "";
    for (const segment of Array.from(value)) {
        if (stringWidth(result + segment) > width) break;
        result += segment;
    }
    return result + " ".repeat(Math.max(0, width - stringWidth(result)));
}

export function PermissionsDialog({
    current,
    allowFullAccess,
    onSelect,
    onClose,
}: {
    current: PermissionMode;
    allowFullAccess: boolean;
    onSelect(mode: PermissionMode): void;
    onClose(): void;
}) {
    const initialIndex = Math.max(
        0,
        OPTIONS.indexOf(current)
    );
    const [selectedIndex, setSelectedIndex] = useState(initialIndex);
    const [confirmFullAccess, setConfirmFullAccess] = useState(false);
    const [confirmIndex, setConfirmIndex] = useState(1);
    const rowWidth = Math.max(24, Math.min(76, useTerminalWidth() - 6));

    useInput((_input, key) => {
        if (confirmFullAccess) {
            if (key.escape) {
                setConfirmFullAccess(false);
                setConfirmIndex(1);
            } else if (key.upArrow || key.downArrow) {
                setConfirmIndex((index) => index === 0 ? 1 : 0);
            } else if (key.return) {
                if (confirmIndex === 0) onSelect("full-access");
                else {
                    setConfirmFullAccess(false);
                    setConfirmIndex(1);
                }
            }
            return;
        }
        if (key.escape) {
            onClose();
        } else if (key.upArrow) {
            setSelectedIndex((index) => (index - 1 + OPTIONS.length) % OPTIONS.length);
        } else if (key.downArrow) {
            setSelectedIndex((index) => (index + 1) % OPTIONS.length);
        } else if (key.return) {
            const selected = OPTIONS[selectedIndex];
            if (!selected) return;
            if (selected === "full-access" && !allowFullAccess) return;
            if (
                selected === "full-access" &&
                current !== "full-access"
            ) {
                setConfirmFullAccess(true);
                return;
            }
            onSelect(selected);
        }
    });

    if (confirmFullAccess) {
        const actions = ["启用 Full Access", "返回"];
        return (
            <Box flexDirection="column" paddingLeft={2} width={rowWidth + 2}>
                <Text color={COLORS.error} bold>◆ 启用 Full Access？</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>将允许当前会话按系统账户权限访问文件和网络。</Text>
                    <Text color={COLORS.dim}>
                        命令将不受 Pillar 沙箱隔离。系统权限、MCP 启用审批和 Hook 信任仍然生效。
                    </Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    {actions.map((label, index) => (
                        <Text
                            key={label}
                            backgroundColor={index === confirmIndex ? COLORS.error : undefined}
                            color={index === confirmIndex ? "white" : undefined}
                            bold={index === confirmIndex}
                        >
                            {fitRow(`${index === confirmIndex ? "›" : " "} ${label}`, rowWidth)}
                        </Text>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>↑↓ 选择  ·  enter 确认  ·  esc 返回</Text>
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" paddingLeft={2} width={rowWidth + 2}>
            <Text color={COLORS.accent} bold>◆ 执行权限</Text>
            <Text color={COLORS.dim}>选择哪些操作可以自动执行。</Text>
            <Box marginTop={1} flexDirection="column">
                {OPTIONS.map((option, index) => {
                    const focused = index === selectedIndex;
                    const active = option === current;
                    return (
                        <Box key={option} flexDirection="column">
                            <Text
                                backgroundColor={focused ? COLORS.accent : undefined}
                                color={focused ? "white" : undefined}
                                bold={focused}
                            >
                                {fitRow(
                                    `${focused ? "›" : " "} ${active ? "●" : " "} ${getPermissionModeShortLabel(option)}${option === "ask" ? "（推荐）" : option === "full-access" && !allowFullAccess ? "（Host 禁用）" : ""}`,
                                    rowWidth
                                )}
                            </Text>
                            <Text color={COLORS.dim}>  {getPermissionModeDescription(option)}</Text>
                        </Box>
                    );
                })}
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim}>Build/Plan 决定工作方式；此处决定访问范围和审批方式。</Text>
                <Text color={COLORS.dim}>↑↓ 选择  ·  enter 切换  ·  esc 返回</Text>
            </Box>
        </Box>
    );
}
