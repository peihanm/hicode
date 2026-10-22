import {useState} from "react";
import {Box, Text, useInput} from "ink";
import {getPermissionModeDescription, getPermissionModeShortLabel, type PermissionMode} from "../../permissions/index.js";
import {COLORS} from "../theme.js";
import {PanelViewport} from "./PanelViewport.js";
import {panelWindow, wrapPanelText, usePanelLayout} from "../panelLayout.js";

const OPTIONS: readonly PermissionMode[] = ["ask", "auto-review", "full-access"];

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
    const {width, height, padding, contentWidth} = usePanelLayout();

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
            <Box flexDirection="column" paddingX={padding} width={width}>
                <Text color={COLORS.error} bold>◆ Enable Full Access?</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>Allow this session to access files and the network as the current OS account.</Text>
                    <Text color={COLORS.dim}>
                        Commands will run outside HiCode sandbox isolation. OS permissions, MCP activation approval and Hook trust still apply.
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
                            {`${index === confirmIndex ? "›" : " "} ${label}`}
                        </Text>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>↑↓ select · enter confirm · esc back</Text>
                </Box>
            </Box>
        );
    }

    const subtitle = "Choose who approves extra access, or allow host execution.";
    const explanation = "/sandbox controls network access for sandboxed commands.";
    const shortcuts = "↑↓ select · enter switch · esc back";
    const bodyHeight = Math.max(2, height - 6 - wrapPanelText(subtitle, contentWidth).length
        - wrapPanelText(explanation, contentWidth).length - wrapPanelText(shortcuts, contentWidth).length);
    const options = OPTIONS.map((option, index) => {
        const focused = index === selectedIndex;
        const label = `${getPermissionModeShortLabel(option)}${option === current ? "  (current)" : ""}${option === "full-access" && !allowFullAccess ? "  (disabled by Host)" : ""}`;
        return [
            ...wrapPanelText(label, Math.max(1, contentWidth - 2)).map((line, i) => <Text key={`label-${i}`} color={focused ? COLORS.accent : undefined} bold={focused}>{i === 0 && focused ? "› " : "  "}{line}</Text>),
            ...wrapPanelText(getPermissionModeDescription(option), Math.max(1, contentWidth - 2)).map((line, i) => <Text key={`description-${i}`} color={COLORS.dim}>{`  ${line}`}</Text>), " ",
        ];
    });
    const window = panelWindow(options.map(lines => lines.length), selectedIndex, bodyHeight);
    return (
        <Box flexDirection="column" paddingX={padding} width={width}>
            <Text color={COLORS.accent} bold>◆ Access & approval</Text>
            <Text color={COLORS.dim}>{subtitle}</Text>
            <Box marginTop={1} flexDirection="column">
                <PanelViewport width={contentWidth} height={bodyHeight} resetKey={OPTIONS[selectedIndex]!}
                    lines={options.slice(window.start, window.end).flat()}/>
                {(window.start > 0 || window.end < options.length) && <Text color={COLORS.dim}>{selectedIndex + 1}/{options.length}</Text>}
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim}>{explanation}</Text>
                <Text color={COLORS.dim}>{shortcuts}</Text>
            </Box>
        </Box>
    );
}
