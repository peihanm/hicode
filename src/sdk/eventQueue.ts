import type {ThreadEvent} from "./protocol.js";

const MAX_EVENTS = 256;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_WAITING_WRITERS = 64;

interface Entry { value: ThreadEvent; bytes: number }
interface Writer extends Entry { resolve(): void }

/** Critical events apply backpressure; transient progress never creates waiting writers. */
export class AsyncEventQueue {
    private readonly buffered: Entry[] = [];
    private readonly writers: Writer[] = [];
    private reader: ((result: IteratorResult<ThreadEvent>) => void) | undefined;
    private bytes = 0;
    private waitingBytes = 0;
    private closed = false;
    private failure: Error | undefined;

    constructor(private readonly onFailure: (error: Error) => void) {}

    push(value: ThreadEvent): Promise<void> {
        if (this.closed) return Promise.resolve();
        const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        if (bytes > MAX_BYTES) {
            this.fail(new Error(`SDK 单个事件超过 ${MAX_BYTES} 字节，事件流已中断`));
            return Promise.resolve();
        }
        const entry = {value, bytes};
        if (this.writers.length === 0 && this.admit(entry)) return Promise.resolve();
        if (value.type === "turn.progress") return Promise.resolve();
        if (this.writers.length >= MAX_WAITING_WRITERS || this.waitingBytes + bytes > MAX_BYTES) {
            this.fail(new Error("SDK 事件生产者超过并发等待上限，事件流已中断"));
            return Promise.resolve();
        }
        this.waitingBytes += bytes;
        return new Promise(resolve => { this.writers.push({...entry, resolve}); });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.finishReader();
    }

    /** Transport loss is explicit: stop retaining events and unblock runtime cleanup. */
    discard(error?: Error): void {
        this.closed = true;
        this.failure ??= error;
        this.buffered.length = 0;
        this.bytes = 0;
        this.waitingBytes = 0;
        for (const writer of this.writers.splice(0)) writer.resolve();
        this.finishReader();
    }

    async *iterate(): AsyncGenerator<ThreadEvent> {
        try {
            while (true) {
                const result = await this.next();
                if (result.done) {
                    if (this.failure) throw this.failure;
                    return;
                }
                yield result.value;
            }
        } finally {
            this.discard();
        }
    }

    private fail(error: Error): void {
        this.discard(error);
        this.onFailure(error);
    }

    private admit(entry: Entry): boolean {
        if (this.reader) {
            const reader = this.reader;
            this.reader = undefined;
            reader({done: false, value: entry.value});
            return true;
        }
        if (this.buffered.length >= MAX_EVENTS || this.bytes + entry.bytes > MAX_BYTES) return false;
        this.buffered.push(entry);
        this.bytes += entry.bytes;
        return true;
    }

    private next(): Promise<IteratorResult<ThreadEvent>> {
        const entry = this.buffered.shift();
        if (entry) {
            this.bytes -= entry.bytes;
            while (this.writers.length && this.admit(this.writers[0]!)) {
                const writer = this.writers.shift()!;
                this.waitingBytes -= writer.bytes;
                writer.resolve();
            }
            return Promise.resolve({done: false, value: entry.value});
        }
        if (this.closed) return Promise.resolve({done: true, value: undefined});
        return new Promise(resolve => { this.reader = resolve; });
    }

    private finishReader(): void {
        if (this.buffered.length || !this.reader) return;
        const reader = this.reader;
        this.reader = undefined;
        reader({done: true, value: undefined});
    }
}
