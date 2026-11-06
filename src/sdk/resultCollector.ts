import type {ThreadEvent, ThreadItem} from "./protocol.js";
import {HiCodeSDKError, type TurnResult} from "./types.js";

export async function collectTurnResult(
    events: AsyncIterable<ThreadEvent>
): Promise<TurnResult> {
    const items = new Map<string, {type: ThreadItem["type"]; completed: boolean}>();
    const completedItems: ThreadItem[] = [];
    let previousSequence: number | undefined;
    let threadId: string | undefined;
    let threadStarted = false;
    let turnId: string | undefined;
    let terminal: Extract<ThreadEvent, {type: "turn.completed"}> | undefined;
    let failure: Extract<ThreadEvent, {type: "turn.failed"}> | undefined;

    for await (const event of events) {
        if (terminal || failure) {
            throw new HiCodeSDKError("event_after_terminal", "SDK event received after the Turn terminal event");
        }
        if (event.protocolVersion !== 1) {
            throw new HiCodeSDKError("invalid_protocol_version", "Unsupported SDK event protocol version");
        }
        if (!event.threadId?.trim() || (threadId !== undefined && event.threadId !== threadId)) {
            throw new HiCodeSDKError("event_thread_mismatch", `SDK event threadId mismatch: ${event.threadId}`);
        }
        threadId = event.threadId;
        if (
            !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
            (previousSequence !== undefined && event.sequence !== previousSequence + 1)
        ) {
            throw new HiCodeSDKError(
                "invalid_event_sequence",
                `SDK event sequence is discontinuous: ${previousSequence} -> ${event.sequence}`
            );
        }
        previousSequence = event.sequence;
        if (event.type !== "thread.started" && event.type !== "turn.started") {
            assertTurn(event.turnId, turnId);
        }

        switch (event.type) {
            case "turn.started":
                if (turnId) {
                    throw new HiCodeSDKError(
                        "duplicate_turn_start",
                        "Multiple turn.started events in the same stream"
                    );
                }
                if (!event.turnId?.trim()) throw new HiCodeSDKError("event_turn_mismatch", "SDK Turn ID must be non-empty");
                turnId = event.turnId;
                break;
            case "turn.draft":
            case "turn.draft_end":
            case "turn.progress":
            case "turn.task_wait":
            case "turn.approval_review":
            case "turn.settled":
                break;
            case "item.started":
                if (items.has(event.item.id)) {
                    throw new HiCodeSDKError(
                        "duplicate_item_start",
                        `Item started twice: ${event.item.id}`
                    );
                }
                if (!event.item.id?.trim() || event.item.status !== "in_progress") {
                    throw new HiCodeSDKError("invalid_item_start", "Item start requires an ID and in_progress status");
                }
                items.set(event.item.id, {type: event.item.type, completed: false});
                break;
            case "item.updated":
            case "item.completed": {
                const item = items.get(event.item.id);
                if (!item || item.completed) {
                    throw new HiCodeSDKError(
                        event.type === "item.updated" ? "unknown_item_update" : "unknown_item_completion",
                        `Event received for an inactive Item: ${event.item.id}`
                    );
                }
                if (item.type !== event.item.type) {
                    throw new HiCodeSDKError("item_type_mismatch", `Item type changed: ${event.item.id}`);
                }
                if (event.type === "item.completed") {
                    if (event.item.status === "in_progress") throw new HiCodeSDKError("invalid_item_completion", `Item is still in progress: ${event.item.id}`);
                    item.completed = true;
                    completedItems.push(event.item);
                }
                break;
            }
            case "turn.completed":
                terminal = event;
                break;
            case "turn.failed":
                failure = event;
                break;
            case "thread.started":
                if (threadStarted || turnId !== undefined) {
                    throw new HiCodeSDKError("invalid_thread_start", "thread.started may occur only once before turn.started");
                }
                threadStarted = true;
                break;
            default:
                rejectUnknownEvent(event);
        }
    }

    const unclosed = [...items.values()].filter(item => !item.completed).length;
    if (unclosed > 0) {
        throw new HiCodeSDKError(
            "unclosed_items",
            `Turn ended with ${unclosed} unclosed Items`
        );
    }
    if (failure) {
        throw new HiCodeSDKError(
            failure.error.code,
            failure.error.message
        );
    }
    if (!turnId || !terminal) {
        throw new HiCodeSDKError(
            "missing_turn_terminal",
            "SDK event stream lacks a complete turn.started/turn.completed pair"
        );
    }
    const finalResponse = [...completedItems].reverse().find(
        (item) => item.type === "agent_message" && item.phase === "final"
    );
    return {
        threadId: terminal.threadId,
        turnId,
        items: completedItems,
        finalResponse: finalResponse?.type === "agent_message"
            ? finalResponse.text
            : "",
        usage: terminal.usage,
        stopReason: terminal.stopReason,
        abortReason: terminal.abortReason,
        iterations: terminal.iterations,
        durationMs: terminal.durationMs,
    };
}

function rejectUnknownEvent(_event: never): never {
    throw new HiCodeSDKError("invalid_event_type", "Unknown SDK event type");
}

function assertTurn(actual: string, expected: string | undefined): void {
    if (!expected || actual !== expected) {
        throw new HiCodeSDKError(
            "event_turn_mismatch",
            `SDK event turnId mismatch: ${actual}`
        );
    }
}
