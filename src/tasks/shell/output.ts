import {open} from "node:fs/promises";
import {selectUtf8Range} from "../../toolResults/utf8.js";

const OUTPUT_PREVIEW_BYTES = 20_000;

async function readOutputTail(path: string, afterBytes: number, maxBytes: number) {
    const handle = await open(path, "r");
    try {
        const {size} = await handle.stat();
        if (afterBytes > size) throw new Error("Shell output capture shrank during wait");
        const start = Math.max(afterBytes, size - maxBytes);
        const buffer = Buffer.alloc(size - start);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
        return {start, ...selectUtf8Range(buffer.subarray(0, bytesRead), bytesRead)};
    } finally {
        await handle.close().catch(() => {});
    }
}

export async function readOutputPreview(path: string): Promise<string> {
    try {
        const {start, content} = await readOutputTail(path, 0, OUTPUT_PREVIEW_BYTES + 4);
        const output = content.toString("utf8");
        return start > 0 ? `[First ${start} bytes omitted]\n ${output}` : output;
    } catch {
        return "";
    }
}

export async function readShellOutputChunk(path: string, afterBytes: number): Promise<{nextOffset: number; content: string} | undefined> {
    try {
        const {start, startAdjustment, content} = await readOutputTail(path, afterBytes, OUTPUT_PREVIEW_BYTES);
        const omitted = start + startAdjustment - afterBytes;
        return {
            nextOffset: start + startAdjustment + content.length,
            content: (omitted > 0 ? `[First ${omitted} new bytes omitted]\n` : "") + content.toString("utf8"),
        };
    } catch (error) {
        // Completion promotes and removes the live capture before publishing its final snapshot.
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}
