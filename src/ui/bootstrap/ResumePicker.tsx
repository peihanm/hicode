import {useMemo} from "react";
import {Box, Text, useInput} from "ink";
import SelectInput from "ink-select-input";
import type {SessionIndexEntry} from "../../session/index.js";
import {COLORS} from "../theme.js";

interface ResumeItem {
    label: string;
    value: string;
}

function pad(value: string, width: number): string {
    return value.length >= width ? `${value.slice(0, width - 1)} ` : value.padEnd(width, " ");
}

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

function formatSessionLabel(session: SessionIndexEntry): string {
    const modified = pad(formatRelativeTime(session.updatedAt), 20);
    const created = pad(formatRelativeTime(session.createdAt), 20);
    const count = pad(String(session.messageCount), 8);
    const summary = session.summary || session.lastPrompt || session.firstPrompt || session.sessionId;
    return `${modified}${created}${count}${summary}`;
}

export function ResumePicker({
                                 sessions,
                                 onSelect,
                                 onCancel,
                             }: {
    sessions: SessionIndexEntry[];
    onSelect: (sessionId: string) => void;
    onCancel: () => void;
}) {
    const items = useMemo<ResumeItem[]>(
        () =>
            sessions.map((session, index) => ({
                label: `${index + 1}. ${formatSessionLabel(session)}`,
                value: session.sessionId,
            })),
        [sessions]
    );

    useInput((_input, key) => {
        if (key.escape) {
            onCancel();
        }
    });

    return (
        <Box flexDirection="column">
            <Box marginBottom={1}>
                <Text bold>    {pad("Modified", 20)}{pad("Created", 20)}{pad("# Msg", 8)}Summary</Text>
            </Box>
            <SelectInput
                items={items}
                onSelect={(item: ResumeItem) => onSelect(item.value)}
            />
            <Box marginTop={1}>
                <Text color={COLORS.dim}>↑↓ 选择 · enter 恢复 · esc 退出</Text>
            </Box>
        </Box>
    );
}
