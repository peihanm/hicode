import {useTerminalInput} from "../input/terminalInput.js";
import {Box, Text} from "ink";
import {PanelSelect} from "../dialogs/PanelSelect.js";
import type {SessionIndexEntry} from "../../session/index.js";
import {COLORS} from "../theme.js";
import {usePanelLayout} from "../panelLayout.js";

function formatRelativeTime(iso: string): string {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return "-";

    const diffSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (diffSeconds < 60) return "<1m ago";

    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;

    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;

    return `${Math.floor(diffMonths / 12)}y ago`;
}

export function ResumePicker({
                                 sessions,
                                 onSelect,
                                 onCancel,
                                 cancelLabel = "Exit",
                             }: {
    sessions: SessionIndexEntry[];
    onSelect: (sessionId: string) => void;
    onCancel: () => void;
    cancelLabel?: string;
}) {
    const {width, height, padding, contentWidth} = usePanelLayout();
    const compact = contentWidth < 80;
    const items = sessions.map((session, index) => {
        const modified = formatRelativeTime(session.updatedAt);
        const created = formatRelativeTime(session.createdAt);
        const count = String(session.messageCount);
        const summary = session.summary || session.sessionId;
        return {
            value: session.sessionId,
            label: compact ? `${index + 1}. ${summary}` : `${modified.padEnd(12)}${created.padEnd(12)}${count.padEnd(8)}${summary}`,
            ...(compact ? {description: `Modified ${modified} · Created ${created} · ${count} messages`} : {}),
        };
    });

    useTerminalInput((_input, key) => {
        if (key.escape) onCancel();
    });

    return (
        <Box flexDirection="column" width={width} paddingX={padding}>
            {!compact && <Box marginBottom={1}><Text bold>{`  ${"Modified".padEnd(12)}${"Created".padEnd(12)}${"# Msg".padEnd(8)}Summary`}</Text></Box>}
            <PanelSelect width={contentWidth} rows={Math.max(2, height - 9)}
                items={items}
                onSelect={(item) => onSelect(item.value)}
            />
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ select · enter resume · esc {cancelLabel}</Text>
            </Box>
        </Box>
    );
}
