import {useTerminalInput} from "../input/terminalInput.js";
import {useState, type ReactNode} from "react";
import {Box, Text} from "ink";
import {COLORS} from "../theme.js";

/** Receives already wrapped physical rows; long selected entries remain scrollable. */
export function PanelViewport({lines, width, height, resetKey}: {
    lines: readonly ReactNode[];
    width: number;
    height: number;
    resetKey: string;
}) {
    const [scroll, setScroll] = useState({key: resetKey, offset: 0});
    const overflowing = lines.length > height;
    const visible = Math.max(1, height - (overflowing ? 1 : 0));
    const offset = Math.min(scroll.key === resetKey ? scroll.offset : 0, Math.max(0, lines.length - visible));
    useTerminalInput((_input, key) => {
        if (key.pageUp || key.pageDown) setScroll({key: resetKey,
            offset: Math.max(0, Math.min(lines.length - visible, offset + (key.pageUp ? -visible : visible)))});
    });
    return <Box width={width} flexDirection="column">
        {lines.slice(offset, offset + visible).map((line, index) => <Text key={index}>{line || " "}</Text>)}
        {overflowing && <Text color={COLORS.dim}>PgUp/PgDn</Text>}
    </Box>;
}
