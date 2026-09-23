import {createHash} from "node:crypto";
import {basename} from "node:path";
import type {ToolCallThread} from "./projection.js";

/** Project only the ordinary read_file envelope; logs, errors and code keep their original presentation. */
export function documentRead(thread: ToolCallThread): {detail: string; summary: string; body: string} | undefined {
    if (thread.name !== "read_file" || thread.status !== "done" || thread.outcome !== "ok" || !thread.result) return;
    const receipt = thread.uiData?.type === "file_read" ? thread.uiData.receipt : undefined;
    if (!receipt || !/\.(md|markdown)$/i.test(receipt.path) ||
        createHash("sha256").update(thread.result.slice(0, receipt.contentStart)).digest("hex") !== receipt.headerHash) return;
    const {start, end, total} = receipt;
    const title = basename(receipt.path);
    const range = start === 1 && end === total
        ? `${total} line${total === 1 ? "" : "s"}`
        : `lines ${start}–${end} of ${total}`;
    let finished = false;
    const body = thread.result.slice(receipt.contentStart).split("\n").map(line => {
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
