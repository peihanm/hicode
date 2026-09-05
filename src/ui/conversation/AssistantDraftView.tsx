import {memo, useSyncExternalStore} from "react";
import {Box, Text} from "ink";
import type {UITurnEventStore} from "../turn/eventStore.js";
import {useTerminalSize} from "../terminalSize.js";
import {textRows} from "../textRows.js";
import {COLORS} from "../theme.js";

export const AssistantDraftView = memo(function AssistantDraftView({store}: {
    store: Pick<UITurnEventStore, "getDraftSnapshot" | "subscribeDraft">;
}) {
    const draft = useSyncExternalStore(store.subscribeDraft, store.getDraftSnapshot, store.getDraftSnapshot);
    const terminal = useTerminalSize();
    if (!draft) return null;
    const width = Math.max(10, terminal.width - 4);
    const rows = textRows(draft.text, width);
    const limit = Math.max(1, Math.min(6, Math.floor(terminal.height / 3)));
    return <Box flexDirection="column" marginTop={1} paddingLeft={2} width={width + 2}>
        <Text color={COLORS.dim}>正在生成{draft.truncated || rows.length > limit ? " · 显示最近正文" : ""}</Text>
        <Text>{rows.slice(-limit).join("\n")}</Text>
    </Box>;
});
