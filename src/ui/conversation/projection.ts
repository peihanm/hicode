import stringWidth from "string-width";
import {describeToolPhase, isSuccessfulToolActivity} from "../../tools/presentation.js";
import {type InputRow, layoutInputRows} from "../input/MultilineTextInput.js";
import type {UIThread} from "./types.js";

export type ToolCallThread = Extract<UIThread, {role: "tool_call"}>;

export interface PhaseGroup {
    kind: "phase_group";
    id: string;
    label: string;
    calls: ToolCallThread[];
}

export type ConversationItem = UIThread | PhaseGroup;

function isToolCall(item: UIThread): item is ToolCallThread {
    return item.role === "tool_call";
}

export function isCoordinationWait(thread: ToolCallThread): boolean {
    if (thread.name !== "task" && thread.name !== "agent_message") return false;
    try {return (JSON.parse(thread.args) as {action?: unknown} | null)?.action === "wait";}
    catch {return false;}
}

/** Default projection folds successful stages using deterministic tool semantics; failures, denials and cancellations retain raw rows. */
export function projectDefaultThreads(threads: UIThread[]): ConversationItem[] {
    const items: ConversationItem[] = [];
    for (let index = 0; index < threads.length;) {
        const thread = threads[index]!;
        if (isToolCall(thread) && (thread.hiddenByFileChange ||
            (isCoordinationWait(thread) && (thread.status === "running" || thread.outcome === "ok")))) {
            index += 1;
            continue;
        }
        if (isToolCall(thread) && isSuccessfulToolActivity(thread)) {
            const phase = describeToolPhase(thread.name, thread.args)!;
            const calls: ToolCallThread[] = [];
            while (index < threads.length) {
                const candidate = threads[index]!;
                const candidatePhase = isToolCall(candidate)
                    ? describeToolPhase(candidate.name, candidate.args)
                    : undefined;
                if (
                    !isToolCall(candidate) ||
                    !isSuccessfulToolActivity(candidate) ||
                    candidatePhase?.kind !== phase.kind
                ) break;
                calls.push(candidate);
                index += 1;
            }
            const visibleCalls = calls.filter((call) =>
                describeToolPhase(call.name, call.args)?.hidden !== true
            );
            if (visibleCalls.length > 0) {
                items.push({
                    kind: "phase_group",
                    id: `phase:${phase.kind}:${calls[0]!.id}:${calls.at(-1)!.id}`,
                    label: phase.label,
                    calls,
                });
            }
            continue;
        }
        items.push(thread);
        index += 1;
    }
    return items;
}

const MIN_USER_MESSAGE_TAIL_WIDTH = 12;

/** Avoid a one- or two-word widow after terminal wrapping. */
export function layoutUserMessageRows(
    text: string,
    terminalWidth: number
): InputRow[] {
    const contentWidth = Math.max(1, terminalWidth - 2);
    const rows = layoutInputRows(text, contentWidth);
    if (rows.length < 2 || /[\r\n]/.test(text)) return rows;
    const last = rows.at(-1)!;
    const previous = rows.at(-2)!;
    const targetTailWidth = Math.min(
        MIN_USER_MESSAGE_TAIL_WIDTH,
        Math.floor(contentWidth / 3)
    );
    let tailWidth = stringWidth(last.text);
    if (tailWidth === 0 || tailWidth >= targetTailWidth) return rows;
    const segments = Array.from(
        new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(previous.text)
    );
    let boundary = previous.end;
    for (
        let index = segments.length - 1;
        index >= 0 && tailWidth < targetTailWidth;
        index--
    ) {
        const segment = segments[index]!;
        boundary = previous.start + segment.index;
        tailWidth += stringWidth(segment.segment);
    }
    if (boundary <= previous.start) return rows;
    return [
        ...rows.slice(0, -2),
        {
            start: previous.start,
            end: boundary,
            text: text.slice(previous.start, boundary),
        },
        {
            start: boundary,
            end: last.end,
            text: text.slice(boundary, last.end),
        },
    ];
}
