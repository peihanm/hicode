import {memo} from "react";
import {Box, Text, useStdout} from "ink";
import type {UIModelStreamInfo} from "../turn/eventStore.js";
import {useTerminalSize} from "../terminalSize.js";
import {useDraftLayout} from "./draftLayout.js";
import {COLORS} from "../theme.js";

export const AssistantDraftView = memo(function AssistantDraftView({phase}: {
    phase?: UIModelStreamInfo["phase"];
}) {
    const value = useDraftLayout();
    const terminal = useTerminalSize();
    const {stdout} = useStdout();
    if (!value) return null;
    const {draft, layout} = value;
    if (!layout.text) return null;
    const inScrollback = stdout.isTTY === true && !!layout.completed;
    const label = phase === "tool_input" ? undefined : phase && phase !== "content" ? "Response draft" : "Generating";
    const heading = [inScrollback ? undefined : label, draft.truncated ? "display limit reached" : undefined].filter(Boolean).join(" · ");
    return <Box flexDirection="column" marginTop={inScrollback ? 0 : 1} paddingLeft={2} width={Math.max(3, terminal.width)}>
        {heading && <Text color={COLORS.dim}>{heading}</Text>}
        <Text>{stdout.isTTY === true ? layout.tail : layout.text}</Text>
    </Box>;
});
