import {createInterface} from "node:readline";
import {readFileSync} from "node:fs";
import {join} from "node:path";

const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
let threadSequence = 0;
let turnSequence = 0;

function send(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on("line", (line) => {
    const message = JSON.parse(line) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
    };
    if (message.method === "initialize") {
        const capabilities = message.params?.capabilities as
            | Record<string, unknown>
            | undefined;
        const config = readFileSync(
            join(process.env.CODEX_HOME ?? "", "config.toml"),
            "utf8"
        );
        if (
            capabilities?.experimentalApi !== true ||
            !config.includes("[permissions.pillar_model.filesystem]") ||
            !config.includes("\":workspace_roots\" = \"read\"")
        ) {
            send({
                id: message.id,
                error: {code: -3, message: "missing restricted profile"},
            });
            return;
        }
        send({id: message.id, result: {userAgent: "fake"}});
        return;
    }
    if (message.method === "initialized") return;
    if (message.method === "permissionProfile/list") {
        const allowed = process.env.PILLAR_TEST_CODEX_PROFILE !== "denied";
        send({
            id: message.id,
            result: {
                data: [{
                    id: "pillar_model",
                    description: "isolated",
                    allowed,
                }],
                nextCursor: null,
            },
        });
        return;
    }
    if (message.method === "thread/start") {
        const params = message.params ?? {};
        if (
            params.ephemeral !== true ||
            params.permissions !== "pillar_model" ||
            params.sandbox !== undefined ||
            params.approvalPolicy !== "never" ||
            typeof params.baseInstructions !== "string" ||
            params.baseInstructions !== params.developerInstructions ||
            !params.baseInstructions.includes("stateless model boundary")
        ) {
            send({
                id: message.id,
                error: {code: -1, message: "unsafe thread settings"},
            });
            return;
        }
        threadSequence += 1;
        send({
            id: message.id,
            result: {
                thread: {id: `thread-fake-${threadSequence}`, ephemeral: true},
                activePermissionProfile: {id: "pillar_model"},
            },
        });
        return;
    }
    if (message.method === "turn/start") {
        const params = message.params ?? {};
        const threadId = String(params.threadId);
        if (
            threadId !== `thread-fake-${threadSequence}` ||
            params.effort !== "high" ||
            params.approvalPolicy !== "never" ||
            params.permissions !== "pillar_model" ||
            params.sandboxPolicy !== undefined
        ) {
            send({
                id: message.id,
                error: {code: -2, message: "unsafe turn settings"},
            });
            return;
        }
        turnSequence += 1;
        const turnId = `turn-fake-${turnSequence}`;
        send({
            id: message.id,
            result: {turn: {id: turnId, status: "inProgress"}},
        });
        queueMicrotask(() => {
            if (process.env.PILLAR_TEST_CODEX_CONTINUOUS_PROGRESS === "1") {
                for (const delay of [5, 15, 25, 35]) {
                    setTimeout(() => send({
                        method: "item/reasoning/summaryTextDelta",
                        params: {
                            threadId,
                            turnId,
                            itemId: "reasoning-progress",
                            delta: "step",
                        },
                    }), delay);
                }
                setTimeout(() => {
                    const final = JSON.stringify({
                        content: "progress complete",
                        tool_calls: [],
                    });
                    send({
                        method: "item/agentMessage/delta",
                        params: {
                            threadId,
                            turnId,
                            itemId: "message-progress",
                            delta: final,
                        },
                    });
                    send({
                        method: "item/completed",
                        params: {
                            threadId,
                            turnId,
                            item: {
                                id: "message-progress",
                                type: "agentMessage",
                                text: final,
                                phase: "final_answer",
                            },
                        },
                    });
                    send({
                        method: "thread/tokenUsage/updated",
                        params: {
                            threadId,
                            turnId,
                            tokenUsage: {
                                total: {
                                    totalTokens: 34,
                                    inputTokens: 30,
                                    outputTokens: 4,
                                },
                                last: {
                                    totalTokens: 34,
                                    inputTokens: 30,
                                    outputTokens: 4,
                                },
                                modelContextWindow: 1050000,
                            },
                        },
                    });
                    send({
                        method: "turn/completed",
                        params: {
                            threadId,
                            turn: {
                                id: turnId,
                                status: "completed",
                                error: null,
                            },
                        },
                    });
                }, 45);
                return;
            }
            const stallMode = process.env.PILLAR_TEST_CODEX_OUTPUT_STALL;
            const shouldStall = stallMode === "always" ||
                (stallMode === "once" && turnSequence === 1);
            if (shouldStall) {
                send({
                    method: "item/reasoning/summaryTextDelta",
                    params: {
                        threadId,
                        turnId,
                        itemId: "reasoning-stalled",
                        delta: "started",
                    },
                });
                send({
                    method: "thread/tokenUsage/updated",
                    params: {
                        threadId,
                        turnId,
                        tokenUsage: {
                            total: {
                                totalTokens: 10,
                                inputTokens: 9,
                                outputTokens: 1,
                            },
                            last: {
                                totalTokens: 10,
                                inputTokens: 9,
                                outputTokens: 1,
                            },
                            modelContextWindow: 1050000,
                        },
                    },
                });
                return;
            }
            const shouldUseForbiddenTool = params.model === "gpt-forbidden" ||
                (params.model === "gpt-forbidden-once" && turnSequence === 1);
            if (shouldUseForbiddenTool) {
                send({
                    method: "item/started",
                    params: {
                        threadId,
                        turnId,
                        item: {
                            id: "command-fake",
                            type: "commandExecution",
                            command: "pwd",
                        },
                    },
                });
                send({
                    method: "thread/tokenUsage/updated",
                    params: {
                        threadId,
                        turnId,
                        tokenUsage: {
                            total: {
                                totalTokens: 10,
                                inputTokens: 9,
                                outputTokens: 1,
                            },
                            last: {
                                totalTokens: 10,
                                inputTokens: 9,
                                outputTokens: 1,
                            },
                            modelContextWindow: 200000,
                        },
                    },
                });
                send({
                    method: "turn/completed",
                    params: {
                        threadId,
                        turn: {
                            id: turnId,
                            status: "interrupted",
                            error: null,
                        },
                    },
                });
                return;
            }
            const repairMode = process.env.PILLAR_TEST_CODEX_BRIDGE_REPAIR;
            const distinctUsage = process.env.PILLAR_TEST_CODEX_DISTINCT_USAGE === "1";
            const shouldReturnMalformedBridge = repairMode === "always" ||
                (repairMode === "1" && turnSequence === 1);
            const final = JSON.stringify({
                content: null,
                tool_calls: [{
                    type: "function",
                    function: {
                        name: shouldReturnMalformedBridge
                            ? 'read_file","arguments":"corrupted internal reasoning'
                            : "read_file",
                        arguments: JSON.stringify({path: "README.md"}),
                    },
                }],
            });
            send({
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId,
                    turnId,
                    itemId: "reasoning-fake",
                    delta: "checking",
                },
            });
            send({
                method: "item/agentMessage/delta",
                params: {
                    threadId,
                    turnId,
                    itemId: "message-fake",
                    delta: final,
                },
            });
            send({
                method: "item/completed",
                params: {
                    threadId,
                    turnId,
                    item: {
                        id: "message-fake",
                        type: "agentMessage",
                        text: final,
                        phase: "final_answer",
                    },
                },
            });
            send({
                method: "thread/tokenUsage/updated",
                params: {
                    threadId,
                    turnId,
                    tokenUsage: {
                        total: {
                            totalTokens: distinctUsage ? 340 : 34,
                            inputTokens: distinctUsage ? 300 : 30,
                            cachedInputTokens: 0,
                            cacheWriteInputTokens: 0,
                            outputTokens: distinctUsage ? 40 : 4,
                            reasoningOutputTokens: 1,
                        },
                        last: {
                            totalTokens: distinctUsage ? 74 : 34,
                            inputTokens: distinctUsage ? 70 : 30,
                            cachedInputTokens: 0,
                            cacheWriteInputTokens: 0,
                            outputTokens: 4,
                            reasoningOutputTokens: 1,
                        },
                        modelContextWindow: distinctUsage ? 1050000 : 200000,
                    },
                },
            });
            send({
                method: "turn/completed",
                params: {
                    threadId,
                    turn: {
                        id: turnId,
                        status: "completed",
                        error: null,
                    },
                },
            });
        });
        return;
    }
    if (message.method === "turn/interrupt") {
        send({id: message.id, result: {}});
    }
});
