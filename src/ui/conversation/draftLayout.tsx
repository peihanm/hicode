import {useStdout} from "ink";
import type {TerminalCursorOutput} from "../input/terminalCursor.js";
import {stripVTControlCharacters} from "node:util";
import stringWidth from "string-width";
import {createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode} from "react";
import {useTerminalSize} from "../terminalSize.js";
import type {UITurnEventStore} from "../turn/eventStore.js";

/** Only the unfinished row is segmented again on append; resize/replacement rebuilds. */
export class DraftLayout {
    private text = "";
    private width = 0;
    private rows: string[] = [];
    private result = {completed: "", tail: "", text: ""};
    private readonly segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

    read(text: string, width: number): {completed: string; tail: string; text: string} {
        const clean = stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
        const columns = Math.max(1, width - 2);
        if (clean === this.text && columns === this.width) return this.result;
        const append = columns === this.width && clean.startsWith(this.text);
        const suffix = append ? (this.rows.pop() ?? "") + clean.slice(this.text.length) : clean;
        if (!append) this.rows = [];
        for (const line of suffix.replace(/\t/g, "    ").split("\n")) {
            let row = "", used = 0;
            for (const {segment} of this.segmenter.segment(line)) {
                const size = stringWidth(segment);
                if (row && used + size > columns) {this.rows.push(row); row = ""; used = 0;}
                row += segment;
                used += size;
            }
            this.rows.push(row);
        }
        this.text = clean;
        this.width = columns;
        this.result = {
            completed: clean && this.rows.length > 1 ? "\n● Generating\n" + this.rows.slice(0, -1).map(row => `  ${row}`).join("\n") + "\n" : "",
            tail: this.rows.at(-1) ?? "", text: clean,
        };
        return this.result;
    }
}

type Draft = NonNullable<ReturnType<UITurnEventStore["getDraftSnapshot"]>>;
const DraftContext = createContext<{draft: Draft; layout: ReturnType<DraftLayout["read"]>} | null>(null);

/** One derived layout per response/viewport is shared by scrollback and the live tail. */
export function DraftLayoutProvider({store, children}: {
    store: Pick<UITurnEventStore, "getDraftSnapshot" | "subscribeDraft">;
    children: ReactNode;
}) {
    const {stdout} = useStdout();
    const releaseFrame = useRef<(() => void)>();
    const subscribe = useCallback((listener: () => void) => store.subscribeDraft(() => {
        releaseFrame.current?.();
        // Suspend stale scrollback restoration before Ink observes a shrinking live tail.
        releaseFrame.current = "holdScrollbackReplay" in stdout
            ? (stdout as TerminalCursorOutput).holdScrollbackReplay() : undefined;
        listener();
    }), [store, stdout]);
    const draft = useSyncExternalStore(subscribe, store.getDraftSnapshot, store.getDraftSnapshot);
    useLayoutEffect(() => {
        releaseFrame.current?.();
        releaseFrame.current = undefined;
    }, [draft]);
    useLayoutEffect(() => () => {releaseFrame.current?.(); releaseFrame.current = undefined;}, []);
    const {width} = useTerminalSize();
    const cache = useRef<{id: string; layout: DraftLayout}>();
    const value = useMemo(() => {
        if (!draft) {cache.current = undefined; return null;}
        if (cache.current?.id !== draft.responseId) cache.current = {id: draft.responseId, layout: new DraftLayout()};
        return {draft, layout: cache.current.layout.read(draft.text, width)};
    }, [draft, width]);
    return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useDraftLayout() {return useContext(DraftContext);}
