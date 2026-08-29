import type {ToolCall} from "../llm/types.js";

const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

export interface ToolCallBatch {
    concurrencySafe: boolean;
    calls: ToolCall[];
}

export function getMaxToolConcurrency(): number {
    const configured = Number.parseInt(
        process.env.PILLAR_MAX_TOOL_USE_CONCURRENCY ?? "",
        10
    );
    return Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_MAX_TOOL_CONCURRENCY;
}

// 与 Claude Code 一致：连续安全工具合并为并发批次，非安全工具各自独占一个批次。
export function partitionToolCalls(
    calls: ToolCall[],
    isConcurrencySafe: (name: string, argsJson: string) => boolean
): ToolCallBatch[] {
    const batches: ToolCallBatch[] = [];
    for (const call of calls) {
        let safe = false;
        try {
            safe = isConcurrencySafe(call.function.name, call.function.arguments);
        } catch {
            safe = false;
        }
        const previous = batches.at(-1);
        if (safe && previous?.concurrencySafe) {
            previous.calls.push(call);
        } else {
            batches.push({concurrencySafe: safe, calls: [call]});
        }
    }
    return batches;
}

export async function mapWithConcurrencyLimit<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    const workers = Array.from({length: workerCount}, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index]!, index);
        }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (rejected) throw rejected.reason;
    return results;
}
