import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS = [
    {label: "Allow once", allow: true},
    {label: "Cancel", allow: false},
] as const;

function fitRow(value: string, width: number): string {
    if (stringWidth(value) > width) {
        let result = "";
        for (const character of Array.from(value)) {
            if (stringWidth(`${result}${character}…`) > width) break;
            result += character;
        }
        return `${result}…`;
    }
    return value + " ".repeat(width - stringWidth(value));
}

export function isNetworkAccessRequest(req: ConfirmReq): boolean {
    return req.presentation?.kind === "network_access" &&
        req.presentation.domains.length > 0;
}

export function NetworkAccessDialog({
    req,
    onDone,
}: {
    req: ConfirmReq;
    onDone(): void;
}) {
    const presentation = req.presentation;
    const [selectedIndex, setSelectedIndex] = useState(0);
    const completedRef = useRef(false);
    const contentWidth = Math.max(20, useTerminalWidth() - 6);

    const finish = (allow: boolean) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve(allow
            ? {behavior: "allow"}
            : {behavior: "deny", message: "用户拒绝临时网络授权"});
        onDone();
    };

    useInput((value, key) => {
        if (completedRef.current) return;
        if (key.upArrow || key.downArrow) {
            setSelectedIndex((index) => (index + 1) % OPTIONS.length);
        } else if (key.return || value === "1" || value === "2") {
            const index = value === "1" ? 0 : value === "2" ? 1 : selectedIndex;
            finish(OPTIONS[index]?.allow === true);
        }
    });

    if (presentation?.kind !== "network_access" || presentation.domains.length === 0) {
        return null;
    }

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.warning} bold>◆ NETWORK ACCESS</Text>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>REQUEST</Text>
                <Text>{presentation.reason} 需要访问：</Text>
                {presentation.domains.map((domain) => (
                    <Text key={domain}>  {domain}</Text>
                ))}
            </Box>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>RISK</Text>
                <Text>本次命令将脱离 OS Sandbox，可直接访问宿主网络、文件和子进程。</Text>
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
                            {fitRow(`${focused ? "›" : " "} ${option.label}`, contentWidth)}
                        </Text>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ 选择  ·  enter 确认  ·  esc 取消</Text>
            </Box>
        </Box>
    );
}
