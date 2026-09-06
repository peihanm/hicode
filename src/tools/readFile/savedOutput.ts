import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {createPreview} from "../../toolResults/format.js";
import type {PersistedToolResult} from "../../toolResults/types.js";
import {throwIfTurnAborted} from "../../runtime/abort.js";

/** Read log lines without loading a potentially 64 MiB artifact into memory. */
export async function readSavedOutput(
    file: PersistedToolResult, startLine: number, limit: number, signal: AbortSignal
): Promise<string> {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat({bigint: true});
        if (!before.isFile() || before.size !== BigInt(file.byteLength)) throw new Error("结果文件已改变");
        const buffer = Buffer.alloc(64 * 1024);
        const decoder = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
        const lines: string[] = [];
        let line = 1;
        let sample = "";
        let lineChars = 0;
        let displayedChars = 0;
        let position = 0;
        let more = false;
        let shortened = false;
        const append = (text: string) => {
            if (line < startLine) return;
            lineChars += text.length;
            sample += text;
            if (sample.length > 128_000) sample = sample.slice(0, 64_000) + sample.slice(-64_000);
        };
        const finishLine = (): boolean => {
            if (line >= startLine) {
                const available = 60_000 - displayedChars - 20;
                if (available < 64) return false;
                const visible = createPreview(sample, available);
                shortened ||= lineChars > visible.length;
                const rendered = `${String(line).padStart(6, " ")}\t${visible}`;
                displayedChars += rendered.length + 1;
                lines.push(rendered);
            }
            line++;
            sample = "";
            lineChars = 0;
            return lines.length < limit;
        };
        scan: while (position < file.byteLength) {
            throwIfTurnAborted(signal);
            const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, file.byteLength - position), position);
            if (!bytesRead) throw new Error("结果文件提前结束");
            position += bytesRead;
            const text = decoder.decode(buffer.subarray(0, bytesRead), {stream: true});
            let start = 0;
            for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
                throwIfTurnAborted(signal);
                append(text.slice(start, index));
                if (!finishLine()) { more = true; break scan; }
                start = index + 1;
            }
            append(text.slice(start));
        }
        if (!more) {
            append(decoder.decode());
            // As with ordinary read_file, a trailing newline has an empty final line.
            if (line >= startLine) {
                const lastLine = line;
                finishLine();
                more = line === lastLine;
            }
        }
        const after = await handle.stat({bigint: true});
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new Error("结果文件在读取期间发生变化");
        }
        return [
            `Saved output: ${JSON.stringify(file.path)}`,
            `Complete artifact: ${file.complete ? "yes" : "no (only the saved portion is available)"}`,
            "保存结果仅是历史日志；编辑源码前请 read_file 原文件确认当前版本。",
            "",
            lines.length ? lines.join("\n") : `offset=${startLine} 超出已保存内容的行范围。`,
            ...(shortened ? ["\n单行过长，省略部分已标记；这不是完整行内容。"] : []),
            ...(more ? [`\n继续读取：read_file 使用相同 path，offset=${line}（行号）。`] : []),
        ].join("\n");
    } finally {
        await handle.close();
    }
}
