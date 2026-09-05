import {createHash} from "node:crypto";
import {readdir, unlink} from "node:fs/promises";
import {join} from "node:path";
import {ensurePrivateStorageDirectory, getSessionContentDirectory, readPrivateStorageTextFile, writeFileAtomically, type PillarStorageLayout} from "../persistence/index.js";
import {decodeSessionContentBlock} from "./codec.js";

type ContentBlock = ReturnType<typeof decodeSessionContentBlock>;
export const MAX_SESSION_CONTENT_BYTES = 128 * 1024 * 1024;
const MAX_BLOCK_BYTES = 72 * 1024 * 1024;
const MAX_BLOCKS = 131_072;
const hashPattern = /^[a-f0-9]{64}$/;

export function isSessionContentId(value: unknown): value is string {
    return typeof value === "string" && hashPattern.test(value);
}

/** One operation owns this cache; neither Root nor Session keeps a second disk state. */
export class SessionContentStore {
    private readonly blocks = new Map<string, {text: string; value: ContentBlock; bytes: number; valueBytes: number; stored: boolean}>();
    private loadedBytes = 0;
    private readonly directory: string;

    constructor(private readonly storage: PillarStorageLayout, cwd: string, sessionId: string) {
        this.directory = getSessionContentDirectory(storage, cwd, sessionId);
    }

    read(id: string): ContentBlock {
        if (!isSessionContentId(id)) throw new Error("Invalid Session content reference");
        const cached = this.blocks.get(id);
        if (cached) return cached.value;
        if (this.blocks.size >= MAX_BLOCKS) throw new Error("Session content count limit exceeded");
        const text = readPrivateStorageTextFile(this.storage, join(this.directory, `${id}.json`), MAX_BLOCK_BYTES);
        if (text === null) throw new Error(`Session content block missing: ${id}`);
        if (createHash("sha256").update(text).digest("hex") !== id) throw new Error(`Session content hash mismatch: ${id}`);
        const bytes = Buffer.byteLength(text);
        this.loadedBytes += bytes;
        if (this.loadedBytes > MAX_SESSION_CONTENT_BYTES) throw new Error("Session content size limit exceeded");
        const value = decodeSessionContentBlock(JSON.parse(text));
        this.blocks.set(id, {text, value, bytes, valueBytes: Buffer.byteLength(JSON.stringify(value.value)), stored: true});
        return value;
    }

    stage(value: ContentBlock): string {
        const text = JSON.stringify(value);
        const id = createHash("sha256").update(text).digest("hex");
        if (!this.blocks.has(id)) {
            const bytes = Buffer.byteLength(text);
            if (bytes > MAX_BLOCK_BYTES) throw new Error("Session content block size limit exceeded");
            this.blocks.set(id, {text, value, bytes, valueBytes: Buffer.byteLength(JSON.stringify(value.value)), stored: false});
        }
        return id;
    }

    bytes(ids: Iterable<string>): number {
        let total = 0;
        for (const id of new Set(ids)) {
            this.read(id);
            total += this.blocks.get(id)!.bytes;
        }
        return total;
    }

    arrayBytes(ids: readonly string[]): number {
        return 2 + Math.max(0, ids.length - 1) + ids.reduce((sum, id) => {
            this.read(id);
            return sum + this.blocks.get(id)!.valueBytes;
        }, 0);
    }

    async persist(ids: ReadonlySet<string>): Promise<void> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        for (const id of ids) {
            const block = this.blocks.get(id)!;
            if (block.stored) continue;
            const path = join(this.directory, `${id}.json`);
            const existing = readPrivateStorageTextFile(this.storage, path, MAX_BLOCK_BYTES);
            if (existing !== null && existing !== block.text) throw new Error(`Session content hash mismatch: ${id}`);
            if (existing === null) await writeFileAtomically(path, block.text, 0o600);
            block.stored = true;
        }
    }

    async collect(retained: ReadonlySet<string>): Promise<void> {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        const files = await readdir(this.directory, {withFileTypes: true});
        // Old and new generations coexist until the reference commit has completed.
        if (files.length > 2 * MAX_BLOCKS) throw new Error("Session content count limit exceeded");
        for (const file of files) {
            // Atomic writer leftovers are not references; only collect our hash-named blocks.
            if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
            if (!file.isFile()) throw new Error("Unsafe Session content block");
            if (!retained.has(file.name.slice(0, -5))) await unlink(join(this.directory, file.name));
        }
    }
}
