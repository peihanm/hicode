import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {ConfirmReq} from "../turn/types.js";
import {PermissionModeHint} from "./DialogFrame.js";
import {COLORS} from "../theme.js";
import {usePanelLayout} from "../panelLayout.js";

const OPTIONS = [
    {label: "Allow for this session", scope: "session"},
    {label: "Allow this connection", scope: "once"},
    {label: "Cancel", scope: undefined},
] as const;

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
    const {width, padding, contentWidth} = usePanelLayout();

    const finish = (scope: "once" | "session" | undefined) => {
        if (completedRef.current) return;
        completedRef.current = true;
        req.resolve(scope
            ? {behavior: "allow", networkScope: scope}
            : {behavior: "deny", message: "User denied temporary network access"});
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
        <Box flexDirection="column" paddingX={padding} width={width}>
            <Text color={COLORS.warning} bold>◆ NETWORK ACCESS</Text>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text color={COLORS.dim} bold>REQUEST</Text>
                <Text>Connect to {presentation.host}:{presentation.port}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column" width={contentWidth}>
                <Text>Allows only this domain and port; files and processes remain protected by the Sandbox.</Text>
                <Text color={COLORS.dim}>Session grants are not saved to project configuration and expire when the session closes.</Text>
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
                            {`${focused ? "›" : " "} ${option.label}`}
                        </Text>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ select · enter confirm · esc cancel</Text>
            </Box>
            <PermissionModeHint />
        </Box>
    );
}
