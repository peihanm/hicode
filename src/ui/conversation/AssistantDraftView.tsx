import {memo, useSyncExternalStore} from "react";
import {Box, Text} from "ink";
import type {UIModelStreamInfo, UITurnEventStore} from "../turn/eventStore.js";
import {useTerminalSize} from "../terminalSize.js";
import {textRows} from "../textRows.js";
import {COLORS} from "../theme.js";

export const AssistantDraftView = memo(function AssistantDraftView({store, phase}: {
    store: Pick<UITurnEventStore, "getDraftSnapshot" | "subscribeDraft">;
    phase?: UIModelStreamInfo["phase"];
}) {
    const draft = useSyncExternalStore(store.subscribeDraft, store.getDraftSnapshot, store.getDraftSnapshot);
    const terminal = useTerminalSize();
    if (!draft) return null;
    const text = draft.text.trimEnd();
    if (!text) return null;
    const width = Math.max(10, terminal.width - 4);
    const rows = textRows(text, width);
    const limit = Math.max(1, Math.min(6, Math.floor(terminal.height / 3)));
    const label = phase === "tool_input" ? "Response commentary" : phase && phase !== "content" ? "Response draft" : "Generating";
    return <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width + 2}>
        <Text color={COLORS.dim}>{label}{draft.truncated || rows.length > limit ? " · showing recent text" : ""}</Text>
        <Text>{rows.slice(-limit).join("\n")}</Text>
    </Box>;
});
