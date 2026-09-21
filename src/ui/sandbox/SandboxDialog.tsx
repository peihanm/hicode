import {useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {SandboxStatus} from "../../sandbox/types.js";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

type NetworkMode = "restricted" | "open";
const options = [
    {mode: "restricted", title: "Restricted", description: "Ask before connecting to new destinations."},
    {mode: "open", title: "Open", description: "Allow internet and local network access without prompts."},
] as const;

export function SandboxDialog({status, configured, fullAccess, onSave, onClose}: {
    status: SandboxStatus;
    configured: NetworkMode;
    fullAccess: boolean;
    onSave(mode: NetworkMode): Promise<void>;
    onClose(): void;
}) {
    const [selected, setSelected] = useState(configured === "open" ? 1 : 0);
    const [saved, setSaved] = useState<NetworkMode>();
    const [error, setError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const width = useTerminalWidth();
    const configuredMode = saved ?? configured;
    const pendingRestart = status.kind === "ready" && status.networkMode !== configuredMode;
    const busy = useRef(false);
    const save = async () => {
        if (busy.current) return;
        const mode = options[selected]!.mode;
        busy.current = true; setSaving(true); setError(undefined);
        try {await onSave(mode); setSaved(mode);}
        catch (err) {setError((err instanceof Error ? err.message : String(err)).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 250));}
        finally {busy.current = false; setSaving(false);}
    };
    useInput((_input, key) => {
        if (busy.current) return;
        if (key.escape) onClose();
        else if (key.upArrow || key.downArrow) setSelected(i => 1 - i);
        else if (key.return) void save();
    });
    return <Box flexDirection="column" paddingLeft={2} paddingY={1} width={Math.max(1, Math.min(84, width - 2))}>
        <Text bold color={COLORS.accent}>◆ Sandbox network</Text>
        <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.dim}>{fullAccess ? "Full Access is active; sandbox settings are not applied." : status.kind === "ready"
                ? `Active: ${status.networkMode === "open" ? "Open" : "Restricted"} · filesystem isolation enabled`
                : `Sandbox unavailable: ${status.reason}`}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column" gap={1}>
            {options.map((item, index) => <Box key={item.mode}>
                <Box width={3} flexShrink={0}>
                    <Text color={COLORS.accent}>{selected === index ? "›" : " "}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text bold={selected === index} color={selected === index ? COLORS.accent : undefined}>
                        {item.title}<Text bold={false} color={COLORS.dim}>{configuredMode === item.mode ? "  · configured" : ""}</Text>
                    </Text>
                    <Text color={COLORS.dim}>{item.description}</Text>
                </Box>
            </Box>)}
        </Box>
        <Box marginTop={1} flexDirection="column">
            {(saving || saved || !pendingRestart) && <Text color={COLORS.dim}>{saving ? "Saving…" : saved ? `✓ Saved · ${saved === "open" ? "Open" : "Restricted"}` : "Changes apply after restarting HiCode."}</Text>}
            {pendingRestart && <Text color={COLORS.accent}>Restart HiCode to apply the configured policy.</Text>}
            <Text color={COLORS.dim}>Project setting · .hicode/settings.local.json</Text>
            {error && <Box marginTop={1}><Text color={COLORS.error}>{error}</Text></Box>}
        </Box>
        <Box marginTop={1}>
            <Text color={COLORS.dim}>↑↓ select · Enter save · Esc close</Text>
        </Box>
    </Box>;
}
