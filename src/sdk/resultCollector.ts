import type {ThreadEvent, ThreadItem} from "./protocol.js";
import {PillarSDKError, type TurnResult} from "./types.js";

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
            throw new PillarSDKError(
                "invalid_event_sequence",
                `SDK event sequence 不连续: ${previousSequence} -> ${event.sequence}`
            );
        }
        previousSequence = event.sequence;
        if (terminal || failure) {
            throw new PillarSDKError(
                "event_after_terminal",
                "Turn terminal event 后仍收到 SDK event"
            );
        }

        switch (event.type) {
            case "turn.started":
                if (turnId) {
                    throw new PillarSDKError(
                        "duplicate_turn_start",
                        "同一事件流包含多个 turn.started"
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
                    throw new PillarSDKError(
                        "duplicate_item_start",
                        `Item 重复 started: ${event.item.id}`
                    );
                }
                activeItems.add(event.item.id);
                break;
            case "item.updated":
                assertTurn(event.turnId, turnId);
                if (!activeItems.has(event.item.id)) {
                    throw new PillarSDKError(
                        "unknown_item_update",
                        `未 started 的 Item 收到 update: ${event.item.id}`
                    );
                }
                break;
            case "item.completed":
                assertTurn(event.turnId, turnId);
                if (!activeItems.delete(event.item.id)) {
                    throw new PillarSDKError(
                        "unknown_item_completion",
                        `未 started 的 Item 收到 completed: ${event.item.id}`
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
        throw new PillarSDKError(
            "unclosed_items",
            `Turn 结束时仍有 ${activeItems.size} 个 Item 未闭合`
        );
    }
    if (failure) {
        throw new PillarSDKError(
            failure.error.code,
            failure.error.message
        );
    }
    if (!turnId || !terminal) {
        throw new PillarSDKError(
            "missing_turn_terminal",
            "SDK event stream 未包含完整 turn.started/turn.completed"
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
        throw new PillarSDKError(
            "event_turn_mismatch",
            `SDK event turnId 不匹配: ${actual}`
        );
    }
}
