import {useMemo, useState} from "react";
import {Box, Text, useInput} from "ink";
import type {SessionIndexEntry} from "../../session/index.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {ResumePicker} from "./ResumePicker.js";

function EmptyResumeState({onClose, message}: {onClose: () => void; message?: string}) {
    useInput((_input, key) => {
        if (key.escape) onClose();
    });
    return (
        <Box flexDirection="column">
            <Text color={message ? COLORS.error : COLORS.dim}>{message ?? "No other previous sessions are available to resume."}</Text>
            <Text color={COLORS.dim}>esc back</Text>
        </Box>
    );
}

export function ResumeDialog({
                                 sessions,
                                 indexError,
                                 currentSessionId,
                                 onSelect,
                                 onClose,
                             }: {
    sessions: SessionIndexEntry[];
    indexError?: string;
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
            <Text bold>↻ Resume  Previous sessions</Text>
            <Text color={COLORS.dim}>
                The current session will be saved and its background tasks closed before switching.
            </Text>
            {error && <Text color={COLORS.error}>Switch failed: {error.slice(0, 500)}</Text>}
            <Box marginTop={1} flexDirection="column">
                {switching ? (
                    <Text color={COLORS.dim}>{SYMBOLS.spinner} Switching session…</Text>
                ) : available.length === 0 ? (
                    <EmptyResumeState onClose={onClose} message={indexError}/>
                ) : (
                    <ResumePicker
                        sessions={available}
                        onSelect={select}
                        onCancel={onClose}
                        cancelLabel="Back"
                    />
                )}
            </Box>
        </Box>
    );
}
