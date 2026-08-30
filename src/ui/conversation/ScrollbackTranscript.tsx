import {useEffect, useRef} from "react";
import {Box, render, useStdout} from "ink";
import type {UIThread} from "./types.js";
import {MessageList, StaticMessageList} from "./MessageList.js";
import {Welcome} from "../bootstrap/Welcome.js";
import {useTerminalSize} from "../terminalSize.js";

/** Clear terminal-owned scrollback and the visible screen before source-backed replay. */
export const CLEAR_SCROLLBACK_AND_SCREEN = "\u001B[3J\u001B[2J\u001B[H";

interface TranscriptSnapshot {
    width: number;
    height: number;
    threadIds: string[];
}

export type TranscriptEmissionPlan =
    | {kind: "none"}
    | {kind: "replay"; includeWelcome: boolean};

/**
 * Finalized threads remain the source of truth. Ink Static owns ordinary append-only writes;
 * width/height changes and non-append mutations require a full source-backed replay.
 */
export function planTranscriptEmission(
    previous: TranscriptSnapshot | undefined,
    current: TranscriptSnapshot,
    showWelcome: boolean
): TranscriptEmissionPlan {
    if (!previous) return {kind: "none"};
    if (previous.width !== current.width || previous.height !== current.height) {
        return {kind: "replay", includeWelcome: showWelcome};
    }
    const isAppendOnly = previous.threadIds.length <= current.threadIds.length &&
        previous.threadIds.every((id, index) => current.threadIds[index] === id);
    if (!isAppendOnly) {
        return {kind: "replay", includeWelcome: showWelcome};
    }
    return {kind: "none"};
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
}): Promise<string> {
    const capture = createTranscriptCaptureOutput(input.width, input.height);
    const instance = render(
        <Box flexDirection="column">
            {input.showWelcome && <Welcome/>}
            <MessageList
                threads={input.threads}
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

/**
 * Interactive TTY resize owner. Ink Static performs ordinary append-only writes. After resize,
 * old terminal-owned rows are cleared and rebuilt from UIThread source at the new size.
 */
export function ScrollbackTranscript({
    threads,
    showWelcome = false,
}: {
    threads: UIThread[];
    showWelcome?: boolean;
}) {
    const {stdout, write} = useStdout();
    const {width, height} = useTerminalSize();
    const previousRef = useRef<TranscriptSnapshot>();
    const isInteractive = stdout.isTTY === true;

    useEffect(() => {
        if (!isInteractive) return;
        const current: TranscriptSnapshot = {
            width,
            height,
            threadIds: threads.map((thread) => thread.id),
        };
        const plan = planTranscriptEmission(
            previousRef.current,
            current,
            showWelcome
        );
        previousRef.current = current;
        if (plan.kind === "none") return;

        // A second Ink renderer cannot be entered while React is flushing this renderer's
        // passive effects. Defer one task so the retained transcript render is isolated.
        let active = true;
        const timer = setTimeout(() => {
            void renderTranscriptForScrollback({
                threads,
                showWelcome: plan.includeWelcome,
                width,
                height,
            }).then((rendered) => {
                if (active) {
                    write(`${CLEAR_SCROLLBACK_AND_SCREEN}${rendered}`);
                }
            }).catch(() => {
                // Keep the existing terminal-owned history if replay rendering fails.
            });
        }, 0);
        timer.unref?.();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [height, isInteractive, showWelcome, threads, width, write]);

    return (
        <StaticMessageList
            threads={threads}
            showWelcome={showWelcome}
            terminalWidth={width}
        />
    );
}
