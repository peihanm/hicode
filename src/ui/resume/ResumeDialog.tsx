import {useMemo, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {SessionIndexEntry} from "../../session/index.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {ResumePicker} from "./ResumePicker.js";

function EmptyResumeState({onClose}: {onClose: () => void}) {
    useInput((_input, key) => {
        if (key.escape) onClose();
    });
    return (
        <Box flexDirection="column">
            <Text color={COLORS.dim}>没有其他可恢复的历史会话。</Text>
            <Text color={COLORS.dim}>esc 返回</Text>
        </Box>
    );
}

export function ResumeDialog({
                                 sessions,
                                 currentSessionId,
                                 onSelect,
                                 onClose,
                             }: {
    sessions: SessionIndexEntry[];
    currentSessionId: string;
    onSelect: (sessionId: string) => Promise<void>;
    onClose: () => void;
}) {
    const available = useMemo(
        () => sessions.filter((session) => session.sessionId !== currentSessionId),
        [currentSessionId, sessions]
    );
    const [switching, setSwitching] = useState(false);
    const [error, setError] = useState<string>();

    const select = (sessionId: string) => {
        setSwitching(true);
        setError(undefined);
        void onSelect(sessionId).catch((reason) => {
            setError(reason instanceof Error ? reason.message : String(reason));
            setSwitching(false);
        });
    };

    return (
        <Box flexDirection="column">
            <Text bold>↻ Resume  恢复历史会话</Text>
            <Text color={COLORS.dim}>
                切换前会保存当前会话，并关闭当前会话的后台任务。
            </Text>
            {error && <Text color={COLORS.error}>切换失败：{error.slice(0, 500)}</Text>}
            <Box marginTop={1} flexDirection="column">
                {switching ? (
                    <Text color={COLORS.dim}>{SYMBOLS.spinner} 正在切换会话…</Text>
                ) : available.length === 0 ? (
                    <EmptyResumeState onClose={onClose}/>
                ) : (
                    <ResumePicker
                        sessions={available}
                        onSelect={select}
                        onCancel={onClose}
                        cancelLabel="返回"
                    />
                )}
            </Box>
        </Box>
    );
}
