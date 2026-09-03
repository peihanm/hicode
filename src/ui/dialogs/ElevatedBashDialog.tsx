import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS = [
    {label: "Run once", allow: true},
    {label: "Cancel", allow: false},
] as const;

interface ElevatedBashInput {
    command: string;
    cwd?: string;
}

function describeElevatedAction(command: string): {
    purpose: string;
    action: string;
} {
    const normalized = command.toLowerCase();
    const targetsLoopback = /(?:localhost|127\.0\.0\.1|\[::1\])/.test(normalized);
    if (targetsLoopback && /\b(?:curl|wget)\b/.test(normalized)) {
        return {purpose: "Verify local service", action: "Verify once"};
    }
    if (
        /(?:http\.server|\bnode\s+[^\n;&|]*(?:server|serve)[^\n;&|]*|\b(?:vite|next)\b.*\b(?:dev|preview)\b|\bnpm\s+(?:run\s+)?(?:start|dev|preview)\b|\bbun\s+(?:run\s+)?(?:start|dev|preview)\b)/
            .test(normalized)
    ) {
        return {purpose: "Start local service", action: "Start once"};
    }
    return {purpose: "Run command on host", action: "Run once"};
}

function readElevatedBashInput(req: ConfirmReq): ElevatedBashInput | undefined {
    if (req.toolName !== "bash" || !req.input || typeof req.input !== "object") {
        return undefined;
    }
    if (!("sandbox_permissions" in req.input) ||
        req.input.sandbox_permissions !== "require_escalated" ||
        !("command" in req.input) ||
        typeof req.input.command !== "string" ||
        !req.input.command.trim()) {
        return undefined;
    }
    const cwd = "cwd" in req.input && typeof req.input.cwd === "string"
        ? req.input.cwd
        : undefined;
    return {command: req.input.command.trim(), ...(cwd ? {cwd} : {})};
}

export function isElevatedBashRequest(req: ConfirmReq): boolean {
    return readElevatedBashInput(req) !== undefined;
}

function truncateToWidth(value: string, width: number): string {
    if (stringWidth(value) <= width) return value;
    const available = Math.max(1, width - 1);
    let result = "";
    for (const character of Array.from(value)) {
        if (stringWidth(result + character) > available) break;
        result += character;
    }
    return `${result}…`;
}

function fitRow(value: string, width: number): string {
    const fitted = truncateToWidth(value, width);
    return fitted + " ".repeat(Math.max(0, width - stringWidth(fitted)));
}

export function ElevatedBashDialog({
    req,
    onDone,
}: {
    req: ConfirmReq;
    onDone(): void;
}) {
    const input = readElevatedBashInput(req);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const completedRef = useRef(false);
    const contentWidth = Math.max(20, useTerminalWidth() - 6);

    const finish = (allow: boolean) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve(allow
            ? {behavior: "allow"}
            : {behavior: "deny", message: "用户拒绝脱离 Sandbox 执行命令"});
        onDone();
    };

    useInput((value, key) => {
        if (completedRef.current) return;
        if (key.upArrow || key.downArrow) {
            setSelectedIndex((index) => (index + 1) % OPTIONS.length);
        } else if (key.return || value === "1" || value === "2") {
            const index = value === "1" ? 0 : value === "2" ? 1 : selectedIndex;
            finish(OPTIONS[index]?.allow === true);
        } else if (value.toLowerCase() === "e") {
            setExpanded((current) => !current);
        }
    });

    if (!input) return null;

    const commandLines = input.command.split("\n");
    const elevatedAction = describeElevatedAction(input.command);
    const commandPreview = truncateToWidth(`$ ${commandLines[0] ?? ""}`, contentWidth);
    const previewTruncated = commandLines.length > 1 ||
        stringWidth(`$ ${commandLines[0] ?? ""}`) > contentWidth;

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.warning} bold>◆ RUN OUTSIDE SANDBOX</Text>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>PURPOSE</Text>
                <Text>{elevatedAction.purpose}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>COMMAND</Text>
                {expanded ? (
                    <Text>{input.command}</Text>
                ) : (
                    <>
                        <Text>{commandPreview}</Text>
                        {previewTruncated && (
                            <Text color={COLORS.dim}>
                                {commandLines.length > 1
                                    ? `+${commandLines.length - 1} more lines · e to expand`
                                    : "command truncated · e to expand"}
                            </Text>
                        )}
                    </>
                )}
                {input.cwd && <Text color={COLORS.dim}>cwd: {input.cwd}</Text>}
            </Box>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>RISK</Text>
                <Text>本次命令可直接访问宿主文件、网络及子进程。</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim} bold>ACTION</Text>
                {OPTIONS.map((option, index) => {
                    const focused = index === selectedIndex;
                    return (
                        <Text
                            key={option.label}
                            backgroundColor={focused ? COLORS.accent : undefined}
                            color={focused ? "white" : undefined}
                            bold={focused}
                        >
                            {fitRow(
                                `${focused ? "›" : " "} ${option.allow ? elevatedAction.action : option.label}`,
                                contentWidth
                            )}
                        </Text>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>
                    ↑↓ 选择  ·  enter 确认  ·  e {expanded ? "收起" : "展开命令"}  ·  esc 取消
                </Text>
            </Box>
        </Box>
    );
}
