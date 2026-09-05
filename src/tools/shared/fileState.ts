import {createHash} from "node:crypto";
import {resolve} from "node:path";

interface FileReadState {
    contentHash: string;
    fullRead: boolean;
    observedFragments: Set<string>;
}

export interface FileStateCheckOptions {
    requireFullRead?: boolean;
    oldString?: string;
    replaceAll?: boolean;
}

export type FileStateCheck =
    | { ok: true }
    | { ok: false; reason: "not_read" | "partial_read" | "stale" };

function key(path: string): string {
    return resolve(path);
}

function normalizeForObservation(content: string): string {
    return content
        .replace(/\r\n/g, "\n")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
}

function contentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

/**
 * Session-scoped file observation ledger used by Read/Edit/Write.
 *
 * It belongs to one Session (or one child Agent), never Root resources:
 * one session cannot authorize another session's edit. Partial reads only
 * authorize exact replacement text that was actually visible to the model.
 */
export class FileStateTracker {
    private readonly states = new Map<string, FileReadState>();

    recordRead(input: {
        path: string;
        content: string;
        observedContent: string;
        fullRead: boolean;
    }): void {
        const existing = this.states.get(key(input.path));
        const hash = contentHash(input.content);
        const sameVersion = existing?.contentHash === hash;
        const observedFragments = sameVersion
            ? new Set(existing.observedFragments)
            : new Set<string>();
        observedFragments.add(normalizeForObservation(input.observedContent));
        this.states.set(key(input.path), {
            contentHash: hash,
            fullRead: Boolean(input.fullRead || (sameVersion && existing?.fullRead)),
            observedFragments,
        });
    }

    check(
        path: string,
        currentContent: string,
        options: FileStateCheckOptions = {}
    ): FileStateCheck {
        const state = this.states.get(key(path));
        if (!state) return {ok: false, reason: "not_read"};
        if (state.contentHash !== contentHash(currentContent)) {
            return {ok: false, reason: "stale"};
        }
        if (options.requireFullRead || options.replaceAll) {
            return state.fullRead
                ? {ok: true}
                : {ok: false, reason: "partial_read"};
        }
        if (!options.oldString || state.fullRead) return {ok: true};
        const oldString = normalizeForObservation(options.oldString);
        return [...state.observedFragments].some((fragment) =>
            fragment.includes(oldString)
        )
            ? {ok: true}
            : {ok: false, reason: "partial_read"};
    }

    recordWrite(input: {
        path: string;
        content: string;
        observedContent?: string;
        modelKnowsWholeFile?: boolean;
    }): void {
        const previous = this.states.get(key(input.path));
        const normalizedContent = normalizeForObservation(input.content);
        const observedFragments = new Set(
            [...(previous?.observedFragments ?? [])].filter((fragment) =>
                normalizedContent.includes(fragment)
            )
        );
        if (input.observedContent !== undefined) {
            observedFragments.add(normalizeForObservation(input.observedContent));
        }
        this.states.set(key(input.path), {
            contentHash: contentHash(input.content),
            fullRead: Boolean(input.modelKnowsWholeFile || previous?.fullRead),
            observedFragments,
        });
    }

    /** 文件恢复后清空旧观察，强制模型重新读取恢复后的版本。 */
    clear(): void {
        this.states.clear();
    }
}

export function createFileStateTracker(): FileStateTracker {
    return new FileStateTracker();
}
