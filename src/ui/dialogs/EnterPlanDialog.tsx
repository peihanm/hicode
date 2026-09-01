import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const MAX_REASON_CHARS = 600;

const OPTIONS = [
    {label: "Start planning", value: "allow"},
    {label: "Continue without a plan", value: "deny"},
] as const;

function readReason(input: unknown): string | undefined {
    if (!input || typeof input !== "object" || !("reason" in input)) {
        return undefined;
    }
    const value = input.reason;
    if (typeof value !== "string") return undefined;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length <= MAX_REASON_CHARS
        ? normalized
        : `${normalized.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function fitRow(value: string, width: number): string {
    let result = "";
    for (const segment of Array.from(value)) {
        if (stringWidth(result + segment) > width) break;
        result += segment;
    }
    return result + " ".repeat(Math.max(0, width - stringWidth(result)));
}

export function EnterPlanDialog({
    req,
    onDone,
}: {
    req: ConfirmReq;
    onDone(): void;
}) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const completedRef = useRef(false);
    const reason = readReason(req.input);
    const rowWidth = Math.max(20, useTerminalWidth() - 6);

    const finish = (allow: boolean, message?: string) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve(allow
            ? {behavior: "allow"}
            : {behavior: "deny", message: message ?? "用户拒绝进入 Plan 模式"});
        onDone();
    };

    useInput((_input, key) => {
        if (completedRef.current) return;
        if (key.escape) {
            finish(false, "用户取消进入 Plan 模式");
        } else if (key.upArrow || key.downArrow) {
            setSelectedIndex((index) => (index + 1) % OPTIONS.length);
        } else if (key.return) {
            finish(OPTIONS[selectedIndex]?.value === "allow");
        }
    });

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.accent} bold>◆ PLAN FIRST?</Text>
            <Box marginTop={1} width={rowWidth}>
                <Text>
                    Inspect the project and propose an implementation plan before editing.
                </Text>
            </Box>
            {reason && (
                <Box marginTop={1} flexDirection="column" width={rowWidth}>
                    <Text color={COLORS.dim} bold>WHY</Text>
                    <Text>{reason}</Text>
                </Box>
            )}
            <Box marginTop={1} flexDirection="column">
                {OPTIONS.map((option, index) => {
                    const focused = index === selectedIndex;
                    const row = fitRow(
                        `${focused ? "›" : " "} ${option.label}`,
                        rowWidth
                    );
                    return (
                        <Text
                            key={option.value}
                            backgroundColor={focused ? COLORS.accent : undefined}
                            color={focused ? "white" : undefined}
                            bold={focused}
                        >
                            {row}
                        </Text>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>
                    ↑↓ 选择  ·  enter 确认  ·  esc 取消
                </Text>
            </Box>
        </Box>
    );
}
