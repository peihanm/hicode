import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {McpApprovalDecision, McpApprovalRequest} from "../../mcp/index.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS: Array<{label: string; value: McpApprovalDecision; description: string}> = [
    {label: "Allow once", value: "once", description: "Start now. Ask again next time."},
    {label: "Always allow for this project", value: "always", description: "Remember for this project. Ask again if configuration changes."},
    {label: "Deny for this project", value: "deny", description: "Remember this denial. Use /mcp reconnect to review it later."},
];

function formatArgs(args: string[]): string {
    let redactNext = false;
    const formatted = args.slice(0, 32).map((arg) => {
        if (redactNext) {
            redactNext = false;
            return "[REDACTED]";
        }
        const separator = arg.indexOf("=");
        const key = separator >= 0 ? arg.slice(0, separator) : arg;
        const sensitive = /(?:token|secret|password|api[-_]?key|authorization)/i.test(key);
        if (!sensitive) return arg.slice(0, 256);
        if (separator >= 0) return `${key}=[REDACTED]`;
        redactNext = true;
        return arg;
    });
    if (args.length > 32) formatted.push(`… ${args.length - 32} args omitted`);
    const line = formatted.join(" ");
    return line.length <= 2000 ? line : `${line.slice(0, 1999)}…`;
}

export function McpApprovalDialog({
                                      request,
                                      onDecision,
                                  }: {
    request: McpApprovalRequest;
    onDecision: (decision: McpApprovalDecision) => void;
}) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const completed = useRef(false);
    const width = Math.max(1, Math.min(76, useTerminalWidth() - 4));
    const finish = (decision: McpApprovalDecision) => {
        if (completed.current) return;
        completed.current = true;
        onDecision(decision);
    };
    useInput((input, key) => {
        if (completed.current) return;
        if (key.escape) finish("skip");
        else if (key.upArrow || key.downArrow) {
            setSelectedIndex(index => (index + (key.upArrow ? -1 : 1) + OPTIONS.length) % OPTIONS.length);
        } else if (key.return || /^[1-3]$/.test(input)) {
            const option = OPTIONS[key.return ? selectedIndex : Number(input) - 1];
            if (option) finish(option.value);
        }
    });

    return (
        <Box flexDirection="column" paddingLeft={2} paddingRight={2}>
            <Box flexDirection="column" width={width}>
                <Text color={COLORS.accent} bold>◆ MCP CONNECTION</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text bold>{request.serverName}</Text>
                    <Text>Allow this project to start this server?</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>COMMAND</Text>
                    <Text>{[request.command.slice(0, 512), formatArgs(request.args)].filter(Boolean).join(" ")}</Text>
                    <Text color={COLORS.dim}>PROJECT</Text>
                    <Text>{request.projectPath.slice(0, 1000)}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    {OPTIONS.map((option, index) => (
                        <Box key={option.value}>
                            <Box width={2} flexShrink={0}>
                                <Text color={COLORS.accent}>{index === selectedIndex ? "❯" : " "}</Text>
                            </Box>
                            <Box flexShrink={1}>
                                <Text color={index === selectedIndex ? COLORS.accent : undefined} bold={index === selectedIndex}>
                                    {index + 1}. {option.label}
                                </Text>
                            </Box>
                        </Box>
                    ))}
                    <Box paddingLeft={2}>
                        <Text color={COLORS.dim}>{OPTIONS[selectedIndex]?.description}</Text>
                    </Box>
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>↑↓ select · 1–3 choose · Enter confirm · Esc skip once</Text>
                </Box>
            </Box>
        </Box>
    );
}
