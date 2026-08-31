import {createInterface} from "node:readline";
import {readFileSync} from "node:fs";
import {join} from "node:path";

const lines = createInterface({input: process.stdin, crlfDelay: Infinity});

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
            params.approvalPolicy !== "never"
        ) {
            send({
                id: message.id,
                error: {code: -1, message: "unsafe thread settings"},
            });
            return;
        }
        send({
            id: message.id,
            result: {
                thread: {id: "thread-fake", ephemeral: true},
                activePermissionProfile: {id: "pillar_model"},
            },
        });
        return;
    }
    if (message.method === "turn/start") {
        const params = message.params ?? {};
        if (
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
        send({
            id: message.id,
            result: {turn: {id: "turn-fake", status: "inProgress"}},
        });
        queueMicrotask(() => {
            if (params.model === "gpt-forbidden") {
                send({
                    method: "item/started",
                    params: {
                        threadId: "thread-fake",
                        turnId: "turn-fake",
                        item: {
                            id: "command-fake",
                            type: "commandExecution",
                            command: "pwd",
                        },
                    },
                });
                send({
                    method: "turn/completed",
                    params: {
                        threadId: "thread-fake",
                        turn: {
                            id: "turn-fake",
                            status: "interrupted",
                            error: null,
                        },
                    },
                });
                return;
            }
            const final = JSON.stringify({
                content: null,
                tool_calls: [{
                    id: "call-fake",
                    type: "function",
                    function: {
                        name: "read_file",
                        arguments: JSON.stringify({path: "README.md"}),
                    },
                }],
            });
            send({
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: "thread-fake",
                    turnId: "turn-fake",
                    itemId: "reasoning-fake",
                    delta: "checking",
                },
            });
            send({
                method: "item/agentMessage/delta",
                params: {
                    threadId: "thread-fake",
                    turnId: "turn-fake",
                    itemId: "message-fake",
                    delta: final,
                },
            });
            send({
                method: "item/completed",
                params: {
                    threadId: "thread-fake",
                    turnId: "turn-fake",
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
                    threadId: "thread-fake",
                    turnId: "turn-fake",
                    tokenUsage: {
                        total: {
                            totalTokens: 34,
                            inputTokens: 30,
                            cachedInputTokens: 0,
                            cacheWriteInputTokens: 0,
                            outputTokens: 4,
                            reasoningOutputTokens: 1,
                        },
                        last: {
                            totalTokens: 34,
                            inputTokens: 30,
                            cachedInputTokens: 0,
                            cacheWriteInputTokens: 0,
                            outputTokens: 4,
                            reasoningOutputTokens: 1,
                        },
                        modelContextWindow: 200000,
                    },
                },
            });
            send({
                method: "turn/completed",
                params: {
                    threadId: "thread-fake",
                    turn: {
                        id: "turn-fake",
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
