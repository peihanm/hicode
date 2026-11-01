import {useTerminalInput} from "../input/terminalInput.js";
import {useRef, useState} from "react";
import {Box, Text} from "ink";
import type {McpApprovalDecision, McpApprovalRequest} from "../../mcp/index.js";
import {COLORS} from "../theme.js";
import {usePanelLayout} from "../panelLayout.js";

const OPTIONS: Array<{label: string; value: McpApprovalDecision}> = [
    {label: "Enable", value: "enable"},
    {label: "Cancel", value: "cancel"},
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
    const {width: terminalWidth, padding, contentWidth: width} = usePanelLayout();
    const finish = (decision: McpApprovalDecision) => {
        if (completed.current) return;
        completed.current = true;
        onDecision(decision);
    };
    useTerminalInput((input, key) => {
        if (completed.current) return;
        if (key.escape) finish("cancel");
        else if (key.upArrow || key.downArrow) {
            setSelectedIndex(index => (index + (key.upArrow ? -1 : 1) + OPTIONS.length) % OPTIONS.length);
        } else if (key.return || /^[1-2]$/.test(input)) {
            const option = OPTIONS[key.return ? selectedIndex : Number(input) - 1];
            if (option) finish(option.value);
        }
    });

    return (
        <Box flexDirection="column" paddingX={padding} width={terminalWidth}>
            <Box flexDirection="column" width={width}>
                <Text color={COLORS.accent} bold>◆ Enable MCP · {request.serverName}</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>Project  {request.projectPath.slice(0, 1000)}</Text>
                    <Text color={COLORS.dim}>{request.type === "http"
                        ? `Endpoint  ${request.url}`
                        : `Command  ${[request.command.slice(0, 512), formatArgs(request.args)].filter(Boolean).join(" ")}`}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    <Text color={COLORS.dim}>Tools run automatically.</Text>
                    <Text color={COLORS.dim}>Use /mcp to require approval or block individual tools.</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                    {OPTIONS.map((option, index) => (
                        <Box key={option.value} flexDirection="column" marginBottom={index < OPTIONS.length - 1 ? 1 : 0}>
                            <Text color={index === selectedIndex ? COLORS.accent : undefined} bold={index === selectedIndex}>
                                {index === selectedIndex ? "❯" : " "} {index + 1}. {option.label}
                            </Text>
                        </Box>
                    ))}
                </Box>
                <Box marginTop={1}>
                    <Text color={COLORS.dim}>↑↓ select · Enter confirm · Esc cancel</Text>
                </Box>
            </Box>
        </Box>
    );
}
