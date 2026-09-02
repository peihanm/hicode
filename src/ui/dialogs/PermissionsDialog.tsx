import {useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {PermissionMode} from "../../permissions/index.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS: ReadonlyArray<{
    mode: PermissionMode;
    label: string;
    description: string;
}> = [
    {
        mode: "default",
        label: "Default",
        description: "Work in the sandbox; ask before elevated or unknown effects.",
    },
    {
        mode: "readOnly",
        label: "Read Only",
        description: "Read automatically; ask before writes and non-read-only commands.",
    },
    {
        mode: "bypassPermissions",
        label: "Bypass",
        description: "Skip ordinary approvals; Sandbox and mandatory safety checks remain.",
    },
];

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
    onSelect,
    onClose,
}: {
    current: PermissionMode;
    onSelect(mode: PermissionMode): void;
    onClose(): void;
}) {
    const initialIndex = Math.max(
        0,
        OPTIONS.findIndex((option) => option.mode === current)
    );
    const [selectedIndex, setSelectedIndex] = useState(initialIndex);
    const [confirmBypass, setConfirmBypass] = useState(false);
    const [confirmIndex, setConfirmIndex] = useState(1);
    const rowWidth = Math.max(24, Math.min(76, useTerminalWidth() - 6));

    useInput((_input, key) => {
        if (confirmBypass) {
            if (key.escape) {
                setConfirmBypass(false);
                setConfirmIndex(1);
            } else if (key.upArrow || key.downArrow) {
                setConfirmIndex((index) => index === 0 ? 1 : 0);
            } else if (key.return) {
                if (confirmIndex === 0) onSelect("bypassPermissions");
                else {
                    setConfirmBypass(false);
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
            if (
                selected.mode === "bypassPermissions" &&
                current !== "bypassPermissions"
            ) {
                setConfirmBypass(true);
                return;
            }
            onSelect(selected.mode);
        }
    });

    if (confirmBypass) {
        const actions = ["Enable Bypass", "Go back"];
        return (
            <Box flexDirection="column" paddingLeft={2} width={rowWidth}>
                <Text color={COLORS.error} bold>◆ ENABLE BYPASS?</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Ordinary Tool approvals will be skipped.</Text>
                    <Text color={COLORS.dim}>
                        Deny/ask rules, elevated commands, Sandbox, MCP approval and Hook trust still apply.
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
        <Box flexDirection="column" paddingLeft={2} width={rowWidth}>
            <Text color={COLORS.accent} bold>◆ PERMISSIONS</Text>
            <Box marginTop={1} flexDirection="column">
                {OPTIONS.map((option, index) => {
                    const focused = index === selectedIndex;
                    const active = option.mode === current;
                    return (
                        <Box key={option.mode} flexDirection="column">
                            <Text
                                backgroundColor={focused ? COLORS.accent : undefined}
                                color={focused ? "white" : undefined}
                                bold={focused}
                            >
                                {fitRow(
                                    `${focused ? "›" : " "} ${active ? "●" : " "} ${option.label}`,
                                    rowWidth
                                )}
                            </Text>
                            <Text color={COLORS.dim}>  {option.description}</Text>
                        </Box>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ 选择  ·  enter 切换  ·  esc 返回</Text>
            </Box>
        </Box>
    );
}
