import {useTerminalInput} from "../input/terminalInput.js";
import {useState} from "react";
import {Box, Text} from "ink";
import {panelWindow, wrapPanelText} from "../panelLayout.js";
import {COLORS} from "../theme.js";
import {PanelViewport} from "./PanelViewport.js";

interface Item {value: string; label: string; description?: string; divider?: boolean}

/** Selection is keyed by identity, so reflow never changes the chosen action. */
export function PanelSelect<T extends Item>({items, width, rows, onSelect}: {
    items: readonly T[];
    width: number;
    rows: number;
    onSelect(item: T): void;
}) {
    const [selected, setSelected] = useState(items[0]?.value);
    const index = Math.max(0, items.findIndex(item => item.value === selected));
    const budget = Math.max(1, rows - 1);
    const rendered = items.map((item, i) => [
        ...(item.divider ? [{text: "", description: false}] : []),
        ...wrapPanelText(`${i === index ? "❯ " : "  "}${item.label}`, width).map(text => ({text, description: false})),
        ...(item.description ? [
            ...wrapPanelText(item.description, Math.max(1, width - 2)).map(text => ({text: `  ${text}`, description: true})),
            {text: "", description: true},
        ] : []),
    ]);
    const window = panelWindow(rendered.map(lines => lines.length), index, budget);
    const lines = rendered.slice(window.start, window.end).flatMap((lines, i) => lines.map(line => ({...line, selected: window.start + i === index})));
    useTerminalInput((input, key) => {
        if (!items.length) return;
        if (key.upArrow || key.downArrow || input === "j" || input === "k") {
            const next = (index + (key.upArrow || input === "k" ? -1 : 1) + items.length) % items.length;
            setSelected(items[next]!.value);
        } else if (key.return) onSelect(items[index]!);
        else if (/^[1-9]$/.test(input)) {
            const item = items[window.start + Number(input) - 1];
            if (item && window.start + Number(input) - 1 < window.end) onSelect(item);
        }
    });
    return <Box width={width} flexDirection="column">
        <PanelViewport width={width} height={budget} resetKey={items[index]?.value ?? "empty"} lines={lines.map((line, i) => <Text key={i}
            color={line.description ? COLORS.dim : line.selected ? COLORS.accent : undefined}
            bold={line.selected && !line.description}>{line.text || " "}</Text>)}/>
        {(window.start > 0 || window.end < items.length) && <Text color={COLORS.dim}>{index + 1}/{items.length}</Text>}
    </Box>;
}
