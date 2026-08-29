import {Box, Text} from "ink";
import SelectInput from "ink-select-input";
import type {McpApprovalDecision, McpApprovalRequest} from "../../mcp/index.js";
import {COLORS} from "../theme.js";

const OPTIONS: Array<{ label: string; value: McpApprovalDecision }> = [
    {label: "1. Allow once", value: "once"},
    {label: "2. Always allow for this project", value: "always"},
    {label: "3. Deny", value: "deny"},
];

function formatArgs(args: string[]): string {
    let redactNext = false;
    return args.map((arg) => {
        if (redactNext) {
            redactNext = false;
            return "[REDACTED]";
        }
        const separator = arg.indexOf("=");
        const key = separator >= 0 ? arg.slice(0, separator) : arg;
        const sensitive = /(?:token|secret|password|api[-_]?key|authorization)/i.test(key);
        if (!sensitive) return arg;
        if (separator >= 0) return `${key}=[REDACTED]`;
        redactNext = true;
        return arg;
    }).join(" ");
}

export function McpApprovalDialog({
                                      request,
                                      onDecision,
                                  }: {
    request: McpApprovalRequest;
    onDecision: (decision: McpApprovalDecision) => void;
}) {
    return (
        <Box flexDirection="column">
            <Box flexDirection="column" borderStyle="round" borderColor={COLORS.confirm} paddingX={1}>
                <Text color={COLORS.confirm}>项目请求启动 MCP Server：{request.serverName}</Text>
                <Text>Command: {request.command}</Text>
                <Text>Args: {formatArgs(request.args) || "(none)"}</Text>
                <Text color={COLORS.dim}>Project: {request.projectPath}</Text>
            </Box>
            <Box marginTop={1}>
                <SelectInput items={OPTIONS} onSelect={(item) => onDecision(item.value)}/>
            </Box>
        </Box>
    );
}
