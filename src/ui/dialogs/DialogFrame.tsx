import type {ReactNode} from "react";
import {Box, Text} from "ink";
import {COLORS} from "../theme.js";

type DialogTone = "accent" | "warning" | "error";

export function PermissionModeHint() {
    return <Text color={COLORS.dim}>Adjust approvals with /permissions after this dialog.{"\n"}Agent review: AI approval · Full Access: no access prompts</Text>;
}

function toneColor(tone: DialogTone): string {
    if (tone === "warning") return COLORS.warning;
    if (tone === "error") return COLORS.error;
    return COLORS.accent;
}

export function DialogFrame({
                                title,
                                subtitle,
                                footer,
                                tone = "accent",
                                children,
                            }: {
    title: string;
    subtitle?: ReactNode;
    footer?: ReactNode;
    tone?: DialogTone;
    children?: ReactNode;
}) {
    const color = toneColor(tone);

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderLeftColor={color}
            paddingLeft={1}
        >
            <Text color={color} bold>◆ {title}</Text>
            {subtitle && (
                <Box marginTop={1} flexDirection="column">
                    {subtitle}
                </Box>
            )}
            {children}
            {footer && (
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>{footer}</Text>
                </Box>
            )}
        </Box>
    );
}

export function DialogIndicator({isSelected}: {isSelected: boolean}) {
    return (
        <Text color={isSelected ? COLORS.accent : COLORS.dim}>
            {isSelected ? "❯ " : "  "}
        </Text>
    );
}

export function DialogItem({isSelected, label}: {isSelected: boolean; label: string}) {
    return (
        <Text color={isSelected ? COLORS.accent : undefined} bold={isSelected}>
            {label}
        </Text>
    );
}
