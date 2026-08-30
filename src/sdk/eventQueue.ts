interface PendingRead<T> {
    resolve(result: IteratorResult<T>): void;
}

export class AsyncEventQueue<T> {
    private readonly buffered: T[] = [];
    private readonly readers: PendingRead<T>[] = [];
    private closed = false;

    push(value: T): void {
        if (this.closed) {
            throw new Error("SDK event queue 已关闭");
        }
        const reader = this.readers.shift();
        if (reader) {
            reader.resolve({done: false, value});
            return;
        }
        this.buffered.push(value);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const reader of this.readers.splice(0)) {
            reader.resolve({done: true, value: undefined});
        }
    }

    async *iterate(): AsyncGenerator<T> {
        while (true) {
            const result = await this.next();
            if (result.done) return;
            yield result.value;
        }
    }

    private next(): Promise<IteratorResult<T>> {
        if (this.buffered.length > 0) {
            const value = this.buffered.shift()!;
            return Promise.resolve({done: false, value});
        }
        if (this.closed) {
            return Promise.resolve({done: true, value: undefined});
        }
        return new Promise<IteratorResult<T>>((resolve) => {
            this.readers.push({resolve});
        });
    }
}
