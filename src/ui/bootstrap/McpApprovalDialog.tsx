import {Box, Text} from "ink";
import SelectInput from "ink-select-input";
import type {McpApprovalDecision, McpApprovalRequest} from "../../mcp/index.js";
import {COLORS} from "../theme.js";
import {DialogFrame, DialogIndicator, DialogItem} from "../dialogs/DialogFrame.js";

const OPTIONS: Array<{ label: string; value: McpApprovalDecision }> = [
    {label: "1. Allow once", value: "once"},
    {label: "2. Always allow for this project", value: "always"},
    {label: "3. Deny", value: "deny"},
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
    return (
        <DialogFrame
            title="MCP Server request"
            subtitle={<Text>项目请求启动 MCP Server：{request.serverName}</Text>}
            footer="↑↓ 选择 · Enter 确认"
        >
            <Box marginTop={1} flexDirection="column">
                <Text>Command: {request.command.slice(0, 512)}</Text>
                <Text>Args: {formatArgs(request.args) || "(none)"}</Text>
                <Text color={COLORS.dim}>
                    Project: {request.projectPath.slice(0, 1000)}
                </Text>
            </Box>
            <Box marginTop={1}>
                <SelectInput
                    items={OPTIONS}
                    onSelect={(item) => onDecision(item.value)}
                    indicatorComponent={DialogIndicator}
                    itemComponent={DialogItem}
                />
            </Box>
        </DialogFrame>
    );
}
