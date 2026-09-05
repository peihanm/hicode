import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import stringWidth from "string-width";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const OPTIONS = [
    {label: "Allow for this session", scope: "session"},
    {label: "Allow this connection", scope: "once"},
    {label: "Cancel", scope: undefined},
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
    return req.presentation?.kind === "network_access";
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

    const finish = (scope: "once" | "session" | undefined) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve(scope
            ? {behavior: "allow", networkScope: scope}
            : {behavior: "deny", message: "用户拒绝临时网络授权"});
        onDone();
    };

    useInput((value, key) => {
        if (completedRef.current) return;
        if (key.escape) finish(undefined);
        else if (key.upArrow || key.downArrow) {
            setSelectedIndex((index) => (index + (key.upArrow ? -1 : 1) + OPTIONS.length) % OPTIONS.length);
        } else if (key.return || /^[1-3]$/.test(value)) {
            const index = key.return ? selectedIndex : Number(value) - 1;
            finish(OPTIONS[index]?.scope);
        }
    });

    if (presentation?.kind !== "network_access") {
        return null;
    }

    return (
        <Box flexDirection="column" paddingLeft={2}>
            <Text color={COLORS.warning} bold>◆ NETWORK ACCESS</Text>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>REQUEST</Text>
                <Text>连接 {presentation.host}:{presentation.port}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text>仅允许此域名与端口；文件与进程仍受 Sandbox 保护。</Text>
                <Text color={COLORS.dim}>会话授权不会写入项目配置，关闭会话后失效。</Text>
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
