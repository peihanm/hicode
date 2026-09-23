import {closeSync, constants, fstatSync, openSync, readSync} from "node:fs";

/** Bounded, stable UTF-8 from one regular-file descriptor; missing files still throw ENOENT. */
export function readBoundedTextFile(path: string, maxBytes: number): string {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid file read budget");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd, {bigint: true});
        if (!before.isFile()) throw new Error(`Not a regular file: ${path}`);
        if (before.size > BigInt(maxBytes)) throw new Error(`File exceeds ${maxBytes} byte size limit: ${path}`);
        // A sentinel byte detects growth without reading to an unbounded EOF.
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (count === 0) break;
            offset += count;
        }
        const after = fstatSync(fd, {bigint: true});
        if (offset > maxBytes) throw new Error(`File exceeds ${maxBytes} byte size limit: ${path}`);
        if (BigInt(offset) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new Error(`File changed while reading: ${path}`);
        }
        return new TextDecoder("utf-8", {fatal: true}).decode(buffer.subarray(0, offset));
    } finally {
        closeSync(fd);
    }
}
