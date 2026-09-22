import {constants} from "node:fs";
import {open} from "node:fs/promises";
import type {BigIntStats} from "node:fs";
const MAX_FILE_SNAPSHOT_BYTES = 20 * 1024 * 1024;

function identity(info: BigIntStats): string {
    return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
}

/** Bounded bytes from one regular-file descriptor, including its version identity. */
export async function readFileSnapshot(path: string): Promise<{content: Buffer}> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat({bigint: true});
        if (!before.isFile()) throw new Error("Only regular files are supported, not directories, symlinks or special files");
        if (before.size > BigInt(MAX_FILE_SNAPSHOT_BYTES)) throw new Error(`File exceeds the ${MAX_FILE_SNAPSHOT_BYTES} byte safe-read limit`);
        const content = Buffer.alloc(Number(before.size));
        let position = 0;
        while (position < content.length) {
            const {bytesRead} = await handle.read(content, position, content.length - position, position);
            if (!bytesRead) break;
            position += bytesRead;
        }
        const after = await handle.stat({bigint: true});
        if (position !== content.length || identity(before) !== identity(after)) throw new Error("File changed while reading; use read_file again");
        return {content};
    } finally { await handle.close(); }
}
