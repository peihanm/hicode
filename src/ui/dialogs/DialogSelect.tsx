import {useRef, useState} from "react";
import {Box} from "ink";
import {useTerminalInput} from "../input/terminalInput.js";
import {DialogIndicator, DialogItem} from "./DialogFrame.js";

/** Small approval menus must never treat pasted numbers or newlines as consent. */
export function DialogSelect<T extends {value: string; label: string}>({items, onSelect, isFocused = true}: {
    items: readonly T[];
    onSelect(item: T): void;
    isFocused?: boolean;
}) {
    const [selected, setSelected] = useState(0);
    const cursor = useRef(0);
    const index = Math.min(selected, Math.max(0, items.length - 1));
    useTerminalInput((input, key) => {
        if (!items.length) return;
        if (key.upArrow || key.downArrow || input === "j" || input === "k") {
            cursor.current = (cursor.current + (key.upArrow || input === "k" ? -1 : 1) + items.length) % items.length;
            setSelected(cursor.current);
        } else if (key.return) onSelect(items[Math.min(cursor.current, items.length - 1)]!);
        else if (/^[1-9]$/.test(input)) {
            const item = items[Number(input) - 1];
            if (item) onSelect(item);
        }
    }, {isActive: isFocused});
    return <Box flexDirection="column">{items.map((item, i) => <Box key={item.value}>
        <DialogIndicator isSelected={i === index}/><DialogItem isSelected={i === index} label={item.label}/>
    </Box>)}</Box>;
}
