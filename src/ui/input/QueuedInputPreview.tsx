import {contentText} from "../../images/content.js";
import {Box, Text} from "ink";
import type {RuntimeQueuedMessage} from "../../runtime/messageQueue.js";
import {layoutInputRows} from "./MultilineTextInput.js";
import {COLORS, SYMBOLS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const MAX_VISIBLE_INPUTS = 3;
const MAX_VISUAL_LINES_PER_INPUT = 2;

function sanitizePreview(value: string): string {
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function QueuedInputPreview({
                                       messages,
                                   }: {
    messages: readonly RuntimeQueuedMessage[];
}) {
    const terminalWidth = useTerminalWidth();
    const userInputs = messages.filter(
        (message) => message.type === "user_input"
    );
    if (userInputs.length === 0) return null;

    const contentWidth = Math.max(1, terminalWidth - 4);
    const visible = userInputs.slice(0, MAX_VISIBLE_INPUTS);
    const remaining = userInputs.length - visible.length;

    return (
        <Box flexDirection="column">
            {visible.map((message) => {
                const rows = layoutInputRows(
                    sanitizePreview(contentText(message.content)),
                    contentWidth
                );
                const shown = rows.slice(0, MAX_VISUAL_LINES_PER_INPUT);
                const truncated = rows.length > shown.length;
                return (
                    <Box key={message.id} flexDirection="column">
                        {shown.map((row, index) => (
                            <Text key={`${message.id}:${index}`} color={COLORS.dim}>
                                {index === 0 ? `${SYMBOLS.prompt} ` : "  "}
                                {row.text}
                                {truncated && index === shown.length - 1 ? "…" : ""}
                            </Text>
                        ))}
                    </Box>
                );
            })}
            <Text color={COLORS.dim}>
                ↑ 编辑排队消息
                {remaining > 0 ? ` · 另有 ${remaining} 条` : ""}
            </Text>
        </Box>
    );
}
