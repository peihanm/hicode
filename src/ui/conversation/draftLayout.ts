import {stripVTControlCharacters} from "node:util";
import {textRows} from "../textRows.js";

/** Completed physical rows enter scrollback; the unfinished row remains retractable in Ink. */
export function layoutDraft(text: string, width: number): {completed: string; tail: string; text: string} {
    const clean = stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
    if (!clean) return {completed: "", tail: "", text: ""};
    const rows = textRows(clean, Math.max(1, width - 2));
    return {
        completed: rows.length > 1 ? "\n● Generating\n" + rows.slice(0, -1).map(row => `  ${row}`).join("\n") + "\n" : "",
        tail: rows.at(-1) ?? "", text: clean,
    };
}
