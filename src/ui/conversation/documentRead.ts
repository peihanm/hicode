import {basename} from "node:path";
import type {ToolCallThread} from "./projection.js";

/** Project only the ordinary read_file envelope; logs, errors and code keep their original presentation. */
export function documentRead(thread: ToolCallThread): {detail: string; summary: string; body: string} | undefined {
    if (thread.name !== "read_file" || thread.status !== "done" || thread.outcome !== "ok" || !thread.result) return;
    const header = /^File: ([^\n]+)\nLine range: (\d+)-(\d+) \/ (\d+)\nNote: left-hand line numbers are not file content; exclude them from edit_file\.edits\[\]\.old_string\.\n\n/.exec(thread.result);
    if (!header || !/\.(md|markdown)$/i.test(header[1]!)) return;
    const start = Number(header[2]), end = Number(header[3]), total = Number(header[4]);
    if (![start, end, total].every(Number.isSafeInteger) || start < 1 || end < start || total < end) return;
    const title = basename(header[1]!);
    const range = start === 1 && end === total
        ? `${total} line${total === 1 ? "" : "s"}`
        : `lines ${start}–${end} of ${total}`;
    let finished = false;
    const body = thread.result.slice(header[0].length).split("\n").map(line => {
        if (finished) return line;
        const prefix = /^ *(\d+)\t/.exec(line);
        if (!prefix || Number(prefix[1]) < start || Number(prefix[1]) > end) return line;
        finished = Number(prefix[1]) === end;
        // Remove one tool prefix only; preserve indentation and numbers belonging to the document.
        return line.slice(prefix[0].length);
    }).join("\n");
    const detail = `${title} · ${range}`;
    return {detail, summary: `Read ${detail}`, body};
}
