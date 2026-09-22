import {useEffect, useRef, useSyncExternalStore} from "react";
import {Box, render, useStdout} from "ink";
import type {UIThread} from "./types.js";
import {MessageList, StaticMessageList} from "./MessageList.js";
import {Welcome} from "../bootstrap/Welcome.js";
import {useTerminalSize} from "../terminalSize.js";
import type {TerminalCursorOutput} from "../input/terminalCursor.js";
import type {UITurnEventStore} from "../turn/eventStore.js";
import {layoutDraft} from "./draftLayout.js";

const noDraft = () => null;
const noSubscription = () => () => {};

/** Clear terminal-owned scrollback and the visible screen before source-backed replay. */
export const CLEAR_SCROLLBACK_AND_SCREEN = "\u001B[3J\u001B[2J\u001B[H";

interface TranscriptSnapshot {
    width: number;
    threads: UIThread[];
    expanded: boolean;
    layoutRevision: number;
    draft?: {responseId: string; text: string};
}

function supportsScrollbackRecording(
    stdout: NodeJS.WriteStream
): stdout is NodeJS.WriteStream & Pick<TerminalCursorOutput, "recordScrollback"> {
    return "recordScrollback" in stdout && typeof stdout.recordScrollback === "function";
}

export type TranscriptEmissionPlan =
    | {kind: "none"}
    | {kind: "append"; from: number; includeWelcome: boolean}
    | {kind: "draft"; text: string}
    | {kind: "replay"; includeWelcome: boolean};

/** Only source/layout changes write history; animation renders must not replay it. */
export function planTranscriptEmission(
    previous: TranscriptSnapshot | undefined,
    current: TranscriptSnapshot,
    showWelcome: boolean
): TranscriptEmissionPlan {
    if (!previous) return {kind: "append", from: 0, includeWelcome: showWelcome};
    const isAppendOnly = previous.threads.length <= current.threads.length &&
        previous.threads.every((thread, index) => current.threads[index] === thread);
    // Permission panels replace the live layout on entry, replacement and dismissal.
    // Rebuild the history boundary rather than trusting Ink's previous erase count.
    const layoutChanged = previous.layoutRevision !== current.layoutRevision;
    const previousDraft = previous.draft?.text ?? "";
    const currentDraft = current.draft?.text ?? "";
    const draftInvalidated = previousDraft.length > 0 && (
        previous.draft?.responseId !== current.draft?.responseId ||
        !currentDraft.startsWith(previousDraft) || previous.threads.length !== current.threads.length
    );
    if (layoutChanged || previous.width !== current.width || previous.expanded !== current.expanded || !isAppendOnly || draftInvalidated) {
        return {kind: "replay", includeWelcome: showWelcome};
    }
    if (previous.threads.length !== current.threads.length) return {kind: "append", from: previous.threads.length, includeWelcome: false};
    return currentDraft.length > previousDraft.length
        ? {kind: "draft", text: currentDraft.slice(previousDraft.length)}
        : {kind: "none"};
}

function createTranscriptCaptureOutput(width: number, height: number): {
    stdout: NodeJS.WriteStream;
    chunks: string[];
} {
    const chunks: string[] = [];
    const write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void
    ) => {
        const encoding = typeof encodingOrCallback === "string"
            ? encodingOrCallback
            : "utf8";
        chunks.push(
            typeof chunk === "string"
                ? chunk
                : Buffer.from(chunk).toString(encoding)
        );
        if (typeof encodingOrCallback === "function") encodingOrCallback();
        callback?.();
        return true;
    }) as NodeJS.WriteStream["write"];
    const stdout = new Proxy(process.stdout, {
        get(target, property) {
            if (property === "write") return write;
            if (property === "columns") return width;
            if (property === "rows") return height;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return {stdout, chunks};
}

function withFinalNewline(value: string): string {
    if (value.length === 0 || value.endsWith("\n")) return value;
    return `${value}\n`;
}

/** Render retained transcript source once at the target terminal width. */
export async function renderTranscriptForScrollback(input: {
    threads: UIThread[];
    showWelcome: boolean;
    width: number;
    height: number;
    expanded?: boolean;
}): Promise<string> {
    const capture = createTranscriptCaptureOutput(input.width, input.height);
    const instance = render(
        <Box flexDirection="column">
            {input.showWelcome && <Welcome/>}
            <MessageList
                threads={input.threads}
                paused
                transcript={input.expanded}
                terminalWidth={input.width}
            />
        </Box>,
        {
            stdout: capture.stdout,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        }
    );
    // A second mounted Ink root can commit on the shared React scheduler's next task.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = capture.chunks.reduce(
        (longest, chunk) => chunk.length > longest.length ? chunk : longest,
        ""
    );
    instance.unmount();
    instance.cleanup();
    return withFinalNewline(output);
}

/** Owns terminal history writes and one-time replay when its presentation changes. */
export function ScrollbackTranscript({
    threads,
    showWelcome = false,
    expanded = false,
    transientPanelId,
    draftStore,
}: {
    threads: UIThread[];
    showWelcome?: boolean;
    expanded?: boolean;
    transientPanelId?: number;
    draftStore?: Pick<UITurnEventStore, "getDraftSnapshot" | "subscribeDraft">;
}) {
    const {stdout, write} = useStdout();
    const {width, height} = useTerminalSize();
    const draft = useSyncExternalStore(draftStore?.subscribeDraft ?? noSubscription, draftStore?.getDraftSnapshot ?? noDraft, noDraft);
    const previousRef = useRef<TranscriptSnapshot>();
    const panelLayout = useRef({id: transientPanelId, revision: 0});
    const isInteractive = stdout.isTTY === true;

    useEffect(() => {
        if (!isInteractive) return;
        if (panelLayout.current.id !== transientPanelId) panelLayout.current.revision += 1;
        panelLayout.current.id = transientPanelId;
        const current: TranscriptSnapshot = {width, threads, expanded, layoutRevision: panelLayout.current.revision,
            ...(draft ? {draft: {responseId: draft.responseId, text: layoutDraft(draft.text, width).completed}} : {})};
        const plan = planTranscriptEmission(previousRef.current, current, showWelcome);
        if (plan.kind === "none") return;

        // Render outside React's current commit. A newer snapshot cancels the pending
        // write, and replans from the last successful write so no append can be lost.
        let active = true;
        const timer = setTimeout(() => {
            const rendering = plan.kind === "draft" ? Promise.resolve(plan.text) : renderTranscriptForScrollback({
                threads: plan.kind === "append" ? threads.slice(plan.from) : threads,
                expanded,
                showWelcome: plan.includeWelcome,
                width,
                height,
            }).then(rendered => rendered + (current.draft?.text ?? ""));
            void rendering.then((rendered) => {
                if (!active) return;
                write(`${plan.kind === "replay" ? CLEAR_SCROLLBACK_AND_SCREEN : ""}${rendered}`);
                // The CLI output adapter retains only this rendered presentation for
                // Ink's emergency overflow redraw; plain/captured streams need no cache.
                if (supportsScrollbackRecording(stdout)) {
                    stdout.recordScrollback(plan.kind === "draft" ? "append" : plan.kind, rendered);
                }
                previousRef.current = current;
            }).catch(() => {
                // Keep the last committed history if rendering fails.
            });
        }, 0);
        timer.unref?.();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [draft, expanded, height, isInteractive, showWelcome, threads, transientPanelId, width, write, stdout]);

    // Redirected output cannot retract terminal rows. Retain append-only output there.
    // Interactive history must not also enter Ink's immutable Static cache: otherwise
    // a later overflow would restore the old expanded history after collapse.
    return isInteractive ? null : (
        <StaticMessageList
            key={String(expanded)}
            threads={threads}
            showWelcome={showWelcome}
            terminalWidth={width}
            transcript={expanded}
        />
    );
}
