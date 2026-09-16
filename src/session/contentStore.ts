import {createHash} from "node:crypto";
import {lstatSync} from "node:fs";
import {readdir, unlink} from "node:fs/promises";
import {join} from "node:path";
import {ensurePrivateStorageDirectory, getSessionContentDirectory, readPrivateStorageTextFile, writeFileAtomically, type HiCodeStorageLayout} from "../persistence/index.js";
import {decodeSessionContentBlock} from "./codec.js";

type ContentBlock = ReturnType<typeof decodeSessionContentBlock>;
export const MAX_SESSION_CONTENT_BYTES = 128 * 1024 * 1024;
const MAX_BLOCK_BYTES = 72 * 1024 * 1024;
const MAX_BLOCKS = 131_072;
const hashPattern = /^[a-f0-9]{64}$/;

export function isSessionContentId(value: unknown): value is string {
    return typeof value === "string" && hashPattern.test(value);
}

/** Freeze committed values so identity reuse never hides later in-place edits. */
export function createSessionValueFreezer() {
    const frozen = new WeakSet<object>();
    const freeze = <T>(value: T): T => {
        if (value && typeof value === "object" && !frozen.has(value)) {
            frozen.add(value);
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
        }
        return value;
    };
    return freeze;
}

/** A writer keeps only immutable identities and sizes between commits, not archive bodies. */
export class SessionContentStore {
    private readonly blocks = new Map<string, {text?: string; value?: ContentBlock; bytes: number; valueBytes: number; stored: boolean; identity?: string}>();
    private readonly staged = new WeakMap<object, {id: string; kind: ContentBlock["kind"]}>();
    private readonly freeze = createSessionValueFreezer();
    private loadedBytes = 0;
    private readonly directory: string;

    constructor(private readonly storage: HiCodeStorageLayout, cwd: string, sessionId: string) {
        this.directory = getSessionContentDirectory(storage, cwd, sessionId);
    }

    read(id: string): ContentBlock {
        if (!isSessionContentId(id)) throw new Error("Invalid Session content reference");
        const cached = this.blocks.get(id);
        if (cached?.value) return cached.value;
        if (this.blocks.size >= MAX_BLOCKS) throw new Error("Session content count limit exceeded");
        const identity = this.identity(id);
        const text = readPrivateStorageTextFile(this.storage, join(this.directory, `${id}.json`), MAX_BLOCK_BYTES);
        if (text === null) throw new Error(`Session content block missing: ${id}`);
        if (identity !== this.identity(id)) throw new Error("Session content changed while reading");
        if (createHash("sha256").update(text).digest("hex") !== id) throw new Error(`Session content hash mismatch: ${id}`);
        const bytes = Buffer.byteLength(text);
        this.loadedBytes += bytes;
        if (this.loadedBytes > MAX_SESSION_CONTENT_BYTES) throw new Error("Session content size limit exceeded");
        const value = decodeSessionContentBlock(JSON.parse(text));
        this.blocks.set(id, {text, value, bytes, valueBytes: Buffer.byteLength(JSON.stringify(value.value)), stored: true, identity});
        return value;
    }

    stage(value: ContentBlock): string {
        const previous = this.staged.get(value.value);
        if (previous?.kind === value.kind && this.blocks.has(previous.id)) return previous.id;
        decodeSessionContentBlock(value);
        const text = JSON.stringify(value);
        const id = createHash("sha256").update(text).digest("hex");
        if (!this.blocks.has(id)) {
            const bytes = Buffer.byteLength(text);
            if (bytes > MAX_BLOCK_BYTES) throw new Error("Session content block size limit exceeded");
            this.blocks.set(id, {text, value, bytes, valueBytes: Buffer.byteLength(JSON.stringify(value.value)), stored: false});
        }
        this.freeze(value.value);
        this.staged.set(value.value, {id, kind: value.kind});
        return id;
    }

    bytes(ids: Iterable<string>): number {
        let total = 0;
        for (const id of new Set(ids)) {
            if (!this.blocks.has(id)) this.read(id);
            total += this.blocks.get(id)!.bytes;
        }
        return total;
    }

    arrayBytes(ids: readonly string[]): number {
        return 2 + Math.max(0, ids.length - 1) + ids.reduce((sum, id) => {
            if (!this.blocks.has(id)) this.read(id);
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
            if (block.text === undefined) throw new Error("Missing staged Session content");
            if (existing === null) await writeFileAtomically(path, block.text, 0o600);
            const identity = this.identity(id);
            if (readPrivateStorageTextFile(this.storage, path, MAX_BLOCK_BYTES) !== block.text || identity !== this.identity(id)) {
                throw new Error("Session content changed while committing");
            }
            block.stored = true;
            block.identity = identity;
        }
    }

    private identity(id: string): string {
        const stat = lstatSync(join(this.directory, `${id}.json`), {bigint: true});
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe Session content block");
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    }

    verifyStored(ids: ReadonlySet<string>): void {
        ensurePrivateStorageDirectory(this.storage, this.directory);
        for (const id of ids) {
            const cached = this.blocks.get(id);
            if (!cached?.stored || cached.identity !== this.identity(id)) throw new Error("Session content changed since last commit");
        }
    }

    releaseBodies(retained: ReadonlySet<string>): void {
        for (const [id, block] of this.blocks) {
            if (!retained.has(id)) this.blocks.delete(id);
            else {delete block.value; delete block.text;}
        }
        this.loadedBytes = 0;
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
