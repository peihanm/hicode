import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {ReadWindow} from "./window.js";
import type {PersistedToolResult} from "../../toolResults/types.js";
import {throwIfTurnAborted} from "../../runtime/abort.js";

/** Read log lines without loading a potentially 64 MiB artifact into memory. */
export async function readSavedOutput(
    file: Pick<PersistedToolResult, "path" | "byteLength" | "complete">, startLine: number, limit: number, signal: AbortSignal,
    kind: "tool" | "archive" | "record" = "tool"
): Promise<string> {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat({bigint: true});
        if (!before.isFile() || before.size !== BigInt(file.byteLength)) throw new Error("Result file changed");
        const buffer = Buffer.alloc(64 * 1024);
        const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
        const window = new ReadWindow([
            `${kind === "archive" ? "Session archive" : kind === "record" ? "Subagent record" : "Saved output"}: ${JSON.stringify(file.path)}`,
            `Complete artifact: ${file.complete ? "yes" : "no (only the saved portion is available)"}`,
            "Saved results are historical logs; use read_file on the source file before editing to confirm its current version.",
        ].join("\n"), startLine, limit);
        let line = 1;
        let pending = "";
        let position = 0;
        let more = false;
        const append = (text: string): boolean => {
            if (line < startLine) return true;
            if (pending.length + text.length > window.maxLineChars) {
                window.rejectOverlongLine();
                return false;
            }
            pending += text;
            return true;
        };
        const finishLine = (): boolean => {
            if (line >= startLine && !window.append(pending)) return false;
            line++;
            pending = "";
            return window.count < limit;
        };
        scan: while (position < file.byteLength) {
            throwIfTurnAborted(signal);
            const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, file.byteLength - position), position);
            if (!bytesRead) throw new Error("Result file ended early");
            position += bytesRead;
            const text = decoder.decode(buffer.subarray(0, bytesRead), {stream: true});
            let start = 0;
            for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
                throwIfTurnAborted(signal);
                if (!append(text.slice(start, index)) || !finishLine()) { more = true; break scan; }
                start = index + 1;
            }
            if (!append(text.slice(start))) { more = true; break; }
        }
        if (!more) {
            if (!append(decoder.decode())) more = true;
            // A trailing newline has an empty final line, matching source reads.
            else if (line >= startLine && !window.append(pending)) more = true;
        }
        const after = await handle.stat({bigint: true});
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new Error("Result file changed while reading");
        }
        return window.render(more).output;
    } finally {
        await handle.close();
    }
}
