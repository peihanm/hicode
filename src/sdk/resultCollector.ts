import type {ThreadEvent, ThreadItem} from "./protocol.js";
import {HiCodeSDKError, type TurnResult} from "./types.js";

export async function collectTurnResult(
    events: AsyncIterable<ThreadEvent>
): Promise<TurnResult> {
    const activeItems = new Set<string>();
    const completedItems: ThreadItem[] = [];
    let previousSequence: number | undefined;
    let turnId: string | undefined;
    let terminal: Extract<ThreadEvent, {type: "turn.completed"}> | undefined;
    let failure: Extract<ThreadEvent, {type: "turn.failed"}> | undefined;

    for await (const event of events) {
        if (
            previousSequence !== undefined &&
            event.sequence !== previousSequence + 1
        ) {
            throw new HiCodeSDKError(
                "invalid_event_sequence",
                `SDK event sequence is discontinuous: ${previousSequence} -> ${event.sequence}`
            );
        }
        previousSequence = event.sequence;
        if (terminal || failure) {
            throw new HiCodeSDKError(
                "event_after_terminal",
                "SDK event received after the Turn terminal event"
            );
        }

        switch (event.type) {
            case "turn.started":
                if (turnId) {
                    throw new HiCodeSDKError(
                        "duplicate_turn_start",
                        "Multiple turn.started events in the same stream"
                    );
                }
                turnId = event.turnId;
                break;
            case "turn.draft":
            case "turn.draft_end":
            case "turn.progress":
                assertTurn(event.turnId, turnId);
                break;
            case "item.started":
                assertTurn(event.turnId, turnId);
                if (activeItems.has(event.item.id)) {
                    throw new HiCodeSDKError(
                        "duplicate_item_start",
                        `Item started twice: ${event.item.id}`
                    );
                }
                activeItems.add(event.item.id);
                break;
            case "item.updated":
                assertTurn(event.turnId, turnId);
                if (!activeItems.has(event.item.id)) {
                    throw new HiCodeSDKError(
                        "unknown_item_update",
                        `Update received for an Item that was not started: ${event.item.id}`
                    );
                }
                break;
            case "item.completed":
                assertTurn(event.turnId, turnId);
                if (!activeItems.delete(event.item.id)) {
                    throw new HiCodeSDKError(
                        "unknown_item_completion",
                        `Completion received for an Item that was not started: ${event.item.id}`
                    );
                }
                completedItems.push(event.item);
                break;
            case "turn.completed":
                assertTurn(event.turnId, turnId);
                terminal = event;
                break;
            case "turn.failed":
                assertTurn(event.turnId, turnId);
                failure = event;
                break;
            case "thread.started":
                break;
        }
    }

    if (activeItems.size > 0) {
        throw new HiCodeSDKError(
            "unclosed_items",
            `Turn ended with ${activeItems.size} unclosed Items`
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

function assertTurn(actual: string, expected: string | undefined): void {
    if (!expected || actual !== expected) {
        throw new HiCodeSDKError(
            "event_turn_mismatch",
            `SDK event turnId mismatch: ${actual}`
        );
    }
}
