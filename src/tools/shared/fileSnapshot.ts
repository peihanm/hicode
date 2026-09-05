import {constants} from "node:fs";
import {open} from "node:fs/promises";
import type {BigIntStats} from "node:fs";
import {MAX_CHECKPOINT_FILE_BYTES} from "../../checkpoints/fingerprint.js";

function identity(info: BigIntStats): string {
    return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
}

/** Bounded bytes from one regular-file descriptor, including its version identity. */
export async function readFileSnapshot(path: string): Promise<{content: Buffer; identity: string}> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat({bigint: true});
        if (!before.isFile()) throw new Error("只支持普通文件，不支持目录、Symlink 或特殊文件");
        if (before.size > BigInt(MAX_CHECKPOINT_FILE_BYTES)) throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} bytes 安全读取/Checkpoint 上限`);
        const content = Buffer.alloc(Number(before.size));
        let position = 0;
        while (position < content.length) {
            const {bytesRead} = await handle.read(content, position, content.length - position, position);
            if (!bytesRead) break;
            position += bytesRead;
        }
        const after = await handle.stat({bigint: true});
        if (position !== content.length || identity(before) !== identity(after)) throw new Error("文件在读取期间发生变化，请重新 read_file");
        return {content, identity: identity(after)};
    } finally { await handle.close(); }
}
