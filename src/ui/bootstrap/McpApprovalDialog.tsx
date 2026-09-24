import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {McpApprovalDecision, McpApprovalRequest} from "../../mcp/index.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS: Array<{label: string; value: McpApprovalDecision; description: string}> = [
    {label: "Connect for this session", value: "once", description: "Use existing tool approvals; ask to connect again next launch."},
    {label: "Always connect and allow tools", value: "trust-tools", description: "Current and future tools run automatically, except your permission rules."},
    {label: "Always connect; keep tool approvals", value: "always", description: "Connect automatically; ask before tools that are not already allowed."},
    {label: "Block this server", value: "deny", description: "Do not connect in this project. Change later with /mcp."},
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
    const width = Math.max(1, Math.min(96, useTerminalWidth() - 4));
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
        } else if (key.return || /^[1-4]$/.test(input)) {
            const option = OPTIONS[key.return ? selectedIndex : Number(input) - 1];
            if (option) finish(option.value);
        }
    });

    return (
        <Box flexDirection="column" paddingLeft={2} paddingRight={2}>
            <Box flexDirection="column" width={width}>
                <Text color={COLORS.accent} bold>◆ MCP CONNECTION · {request.serverName}</Text>
                <Text color={COLORS.dim}>Choose connection and tool permissions for this project.</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>Project  {request.projectPath.slice(0, 1000)}</Text>
                    <Text color={COLORS.dim}>Command  {[request.command.slice(0, 512), formatArgs(request.args)].filter(Boolean).join(" ")}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    {OPTIONS.map((option, index) => (
                        <Box key={option.value} flexDirection="column" marginBottom={index < OPTIONS.length - 1 ? 1 : 0}>
                            <Text color={index === selectedIndex ? COLORS.accent : undefined} bold={index === selectedIndex}>
                                {index === selectedIndex ? "❯" : " "} {index + 1}. {option.label}
                            </Text>
                            <Box paddingLeft={5}><Text color={COLORS.dim}>{option.description}</Text></Box>
                        </Box>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>↑↓ select · 1–4 choose · Enter confirm · Esc skip once</Text>
                </Box>
            </Box>
        </Box>
    );
}
