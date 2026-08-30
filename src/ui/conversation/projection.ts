import stringWidth from "string-width";
import {describeToolCall, isSuccessfulToolActivity} from "../../tools/presentation.js";
import {type InputRow, layoutInputRows} from "../input/MultilineTextInput.js";
import type {UIThread} from "./types.js";

export type ToolCallThread = Extract<UIThread, {role: "tool_call"}>;

export interface ActivityGroup {
    kind: "activity_group";
    id: string;
    calls: ToolCallThread[];
}

export interface AgentBatch {
    kind: "agent_batch";
    id: string;
    calls: ToolCallThread[];
}

export type ConversationItem = UIThread | ActivityGroup | AgentBatch;

export function isToolCall(item: UIThread): item is ToolCallThread {
    return item.role === "tool_call";
}

/** 默认投影只折叠成功的只读探索；失败、拒绝和取消始终保留原始行。 */
export function projectDefaultThreads(threads: UIThread[]): ConversationItem[] {
    const items: ConversationItem[] = [];
    for (let index = 0; index < threads.length;) {
        const thread = threads[index]!;
        if (isToolCall(thread) && thread.hiddenByFileChange) {
            index += 1;
            continue;
        }
        if (isToolCall(thread) && isSuccessfulToolActivity(thread)) {
            const calls: ToolCallThread[] = [];
            while (index < threads.length) {
                const candidate = threads[index]!;
                if (!isToolCall(candidate) || !isSuccessfulToolActivity(candidate)) break;
                calls.push(candidate);
                index += 1;
            }
            const visibleCalls = calls.filter(
                (call) => describeToolCall(call.name, call.args).activity?.kind !== "silent"
            );
            if (visibleCalls.length >= 2) {
                items.push({
                    kind: "activity_group",
                    id: `activity:${calls[0]!.id}:${calls.at(-1)!.id}`,
                    calls,
                });
            } else if (visibleCalls.length === 1) {
                items.push(visibleCalls[0]!);
            }
            continue;
        }
        if (isToolCall(thread) && thread.name === "agent") {
            const calls: ToolCallThread[] = [];
            const turnId = thread.turnId;
            while (index < threads.length) {
                const candidate = threads[index]!;
                if (
                    !isToolCall(candidate) ||
                    candidate.name !== "agent" ||
                    candidate.turnId !== turnId
                ) break;
                calls.push(candidate);
                index += 1;
            }
            if (calls.length > 1) {
                items.push({
                    kind: "agent_batch",
                    id: `agents:${calls[0]!.id}:${calls.at(-1)!.id}`,
                    calls,
                });
            } else {
                items.push(calls[0]!);
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
    const contentWidth = Math.max(8, terminalWidth - 2);
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
