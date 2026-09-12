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
        const actions = ["Enable Full Access", "Back"];
        return (
            <Box flexDirection="column" paddingLeft={2} width={rowWidth + 2}>
                <Text color={COLORS.error} bold>◆ Enable Full Access?</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Allow this session to access files and the network as the current OS account.</Text>
                    <Text color={COLORS.dim}>
                        Commands will run outside Pillar sandbox isolation. OS permissions, MCP activation approval and Hook trust still apply.
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
                    <Text color={COLORS.dim}>↑↓ select · enter confirm · esc back</Text>
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" paddingLeft={2} width={rowWidth + 2}>
            <Text color={COLORS.accent} bold>◆ Execution permissions</Text>
            <Text color={COLORS.dim}>Choose how additional access is approved.</Text>
            <Box marginTop={1} flexDirection="column">
                {OPTIONS.map((option, index) => {
                    const focused = index === selectedIndex;
                    const active = option === current;
                    return (
                        <Box key={option} marginTop={index === 0 ? 0 : 1}>
                            <Box width={2} flexShrink={0}>
                                <Text color={COLORS.accent}>{focused ? "›" : " "}</Text>
                            </Box>
                            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                                <Text color={focused ? COLORS.accent : undefined} bold={focused}>
                                    {getPermissionModeShortLabel(option)}
                                    <Text color={COLORS.dim} bold={false}>
                                        {active ? "  (current)" : ""}
                                        {option === "full-access" && !allowFullAccess ? "  (disabled by Host)" : ""}
                                    </Text>
                                </Text>
                                <Text color={COLORS.dim}>{getPermissionModeDescription(option)}</Text>
                            </Box>
                        </Box>
                    );
                })}
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim}>Build/Plan controls the work mode; this controls access and approval.</Text>
                <Text color={COLORS.dim}>↑↓ select · enter switch · esc back</Text>
            </Box>
        </Box>
    );
}
