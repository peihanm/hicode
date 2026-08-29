import type {ReactNode} from "react";
import {Box, Text} from "ink";
import type {IndicatorProps, ItemProps} from "ink-select-input";
import {COLORS} from "../theme.js";

type DialogTone = "accent" | "warning" | "error";

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

export function DialogIndicator({isSelected}: IndicatorProps) {
    return (
        <Text color={isSelected ? COLORS.accent : COLORS.dim}>
            {isSelected ? "❯ " : "  "}
        </Text>
    );
}

export function DialogItem({isSelected, label}: ItemProps) {
    return (
        <Text color={isSelected ? COLORS.accent : undefined} bold={isSelected}>
            {label}
        </Text>
    );
}
