import {useEffect, useRef, useState} from "react";
import {Text} from "ink";
import {stripVTControlCharacters} from "node:util";
import {useTerminalInput} from "./terminalInput.js";
import {COLORS} from "../theme.js";

const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

/** Single-line fields share the terminal paste boundary with the main input. */
export function TextInput({value, onChange, onSubmit, placeholder = "", mask, focus = true}: {
    value: string;
    onChange(value: string): void;
    onSubmit(value: string): void;
    placeholder?: string;
    mask?: string;
    focus?: boolean;
}) {
    const current = useRef({value, cursor: value.length});
    const [cursor, setCursor] = useState(value.length);
    useEffect(() => {
        if (current.current.value !== value) {
            current.current = {value, cursor: value.length};
            setCursor(value.length);
        }
    }, [value]);
    const update = (next: string, offset: number) => {
        const previous = current.current.value;
        current.current = {value: next, cursor: offset};
        setCursor(offset);
        if (next !== previous) onChange(next);
    };
    const insert = (text: string) => {
        const {value, cursor} = current.current;
        const clean = stripVTControlCharacters(text).replace(/\r\n?|\n/g, " ")
            .replaceAll("\t", "    ").replace(/[\x00-\x1f\x7f]/g, "");
        update(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
    };
    useTerminalInput((text, key) => {
        const {value, cursor} = current.current;
        const offsets = [...segmenter.segment(value)].map(part => part.index);
        const previous = offsets.filter(offset => offset < cursor).at(-1) ?? 0;
        const next = offsets.find(offset => offset > cursor) ?? value.length;
        if (key.return) onSubmit(value);
        else if (key.leftArrow) update(value, previous);
        else if (key.rightArrow) update(value, next);
        else if (key.backspace || key.delete) update(value.slice(0, previous) + value.slice(cursor), previous);
        else if (!key.ctrl && !key.meta && !key.escape && !key.tab && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) insert(text);
    }, {isActive: focus, onPaste: insert});
    const safeCursor = Math.min(cursor, value.length);
    const display = (text: string) => mask ? mask.repeat([...segmenter.segment(text)].length) : text;
    if (!focus) return <Text>{value ? display(value) : <Text color={COLORS.dim}>{placeholder}</Text>}</Text>;
    if (!value && placeholder) return <Text color={COLORS.dim}><Text inverse>{placeholder[0]}</Text>{placeholder.slice(1)}</Text>;
    const next = [...segmenter.segment(value)].find(part => part.index > safeCursor)?.index ?? value.length;
    return <Text>{display(value.slice(0, safeCursor))}<Text inverse>{display(value.slice(safeCursor, next)) || " "}</Text>{display(value.slice(next))}</Text>;
}
