import {createHash} from "node:crypto";
import {resolve} from "node:path";
import type {Message} from "../../llm/types.js";
import type {ToolExecutionResult} from "../../toolResults/index.js";

type ByteRange = readonly [start: number, end: number];
interface FileEditRange { start: number; end: number; insertedBytes: number }
interface Source { path: string; hash: string; size: number; identity?: string }
interface Segment { source: Source; start: number; end: number; fileStart: number }
interface Evidence { content: string; segments: Segment[]; targets: Source[] }
interface FileReadState { hash: string; size: number; ranges: ByteRange[]; identity?: string }

export function normalizeFileText(content: string): string {
    return content.replace(/\r\n?/g, "\n");
}

function hash(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

function merge(ranges: readonly ByteRange[]): ByteRange[] {
    const result: Array<[number, number]> = [];
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const previous = result[result.length - 1];
        if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
        else result.push([start, end]);
    }
    return result;
}

type FileStateCheck =
    | {ok: true}
    | {ok: false; reason: "not_read" | "partial_read" | "stale"};

/** Session-owned delivered evidence. Disk reads alone never grant edit rights. */
export class FileStateTracker {
    private readonly states = new Map<string, FileReadState>();
    private readonly pending = new Map<string, Evidence>();

    stageRead(input: {
        toolCallId: string; path: string; content: string | Buffer; normalizedBytes: number;
        output: string; segments: Array<readonly [number, number, number]>; identity?: string;
    }): void {
        const source: Source = {path: resolve(input.path), hash: hash(input.content), size: input.normalizedBytes,
            ...(input.identity ? {identity: input.identity} : {})};
        this.pending.set(input.toolCallId, {content: input.output, targets: [source],
            segments: input.segments.map(([start, end, fileStart]) => ({source, start, end, fileStart}))});
    }

    bindOutput(toolCallId: string, original: string, result: Pick<ToolExecutionResult, "modelContent" | "persisted">): void {
        const evidence = this.pending.get(toolCallId);
        if (!evidence || evidence.content !== original) return;
        // Saved output is a log, not an observation of the current source file.
        if (result.persisted || !result.modelContent.startsWith(original)) this.pending.delete(toolCallId);
        else evidence.content = result.modelContent;
    }

    commitVisible(messages: readonly Message[]): void {
        for (const message of messages) {
            if (message.role !== "tool") continue;
            const evidence = this.pending.get(message.tool_call_id);
            if (!evidence || evidence.content !== message.content) continue;
            for (const source of evidence.targets) this.observe(source, []);
            for (const segment of evidence.segments) this.observe(segment.source,
                [[segment.fileStart, segment.fileStart + segment.end - segment.start]]);
        }
        this.pending.clear();
    }

    private observe(source: Source, ranges: ByteRange[]): void {
        const previous = this.states.get(source.path);
        this.states.set(source.path, {hash: source.hash, size: source.size, identity: source.identity,
            ranges: merge([...(previous?.hash === source.hash ? previous.ranges : []), ...ranges])});
    }

    check(path: string, content: string | Buffer, options: {
        requireFullRead?: boolean; replaceAll?: boolean; ranges?: readonly ByteRange[]; identity?: string;
    } = {}): FileStateCheck {
        const state = this.states.get(resolve(path));
        if (!state) return {ok: false, reason: "not_read"};
        if (state.hash !== hash(content) || (options.identity && options.identity !== state.identity)) {
            return {ok: false, reason: "stale"};
        }
        const required = options.requireFullRead || options.replaceAll ? [[0, state.size] as const] : options.ranges ?? [];
        return required.every(([start, end]) => state.size === 0 || state.ranges.some(([a, b]) => a <= start && b >= end))
            ? {ok: true} : {ok: false, reason: "partial_read"};
    }

    recordWrite(input: {path: string; content: string; beforeContent?: string;
        edits?: readonly FileEditRange[]; modelKnowsWholeFile?: boolean; identity?: string}): void {
        const key = resolve(input.path);
        const previous = this.states.get(key);
        const size = Buffer.byteLength(normalizeFileText(input.content));
        let ranges: ByteRange[] = input.modelKnowsWholeFile ? [[0, size]] :
            previous && input.beforeContent !== undefined && previous.hash === hash(input.beforeContent) ? [...previous.ranges] : [];
        if (!input.modelKnowsWholeFile) {
            for (const edit of [...(input.edits ?? [])].reverse()) {
                const delta = edit.insertedBytes - (edit.end - edit.start);
                ranges = ranges.flatMap(([start, end]): ByteRange[] => [
                    ...(start < edit.start ? [[start, Math.min(end, edit.start)] as const] : []),
                    ...(end > edit.end ? [[Math.max(start, edit.end) + delta, end + delta] as const] : []),
                ]);
                ranges.push([edit.start, edit.start + edit.insertedBytes]);
            }
        }
        this.states.set(key, {hash: hash(input.content), size, ranges: merge(ranges), identity: input.identity});
    }

    forget(path: string): void { this.states.delete(resolve(path)); }
    clear(): void { this.states.clear(); this.pending.clear(); }
}

export function createFileStateTracker(): FileStateTracker { return new FileStateTracker(); }
