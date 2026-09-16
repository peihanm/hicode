import type {HookInput, HookEnvelope} from "../../src/hooks/types.js";
import {describe, expect, test} from "bun:test";
import {createHookPromptExecutorFactory} from "../../src/hooks/prompt.js";
import type {LLMCaller} from "../../src/llm/types.js";
import {createHiCodeStorageLayout} from "../../src/persistence/index.js";

function envelope(event: HookInput): HookEnvelope {
    return {version: 2, cwd: "/project", hook_id: "id", execution_id: "execution", dispatch_id: "dispatch",
        source: {source: "host", id: "fixture"}, purpose: event.hook_event_name === "PreToolUse" || event.hook_event_name === "UserPromptSubmit" ? "control" : "observe", event};
}
const storage = createHiCodeStorageLayout({hicodeHome: "/tmp/hicode-hook-test"});

const usage = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
};

describe("Prompt Hook executor", () => {
    test("只向 fast caller 暴露私有提交工具并严格解析结构化决定", async () => {
        const calls: Parameters<LLMCaller>[] = [];
        const callLLM: LLMCaller = async (...args) => {
            calls.push(args);
            return {
                message: {role: "assistant", content: null},
                toolCalls: [{
                    id: "decision",
                    type: "function",
                    function: {
                        name: "submit_hook_decision",
                        arguments: JSON.stringify({
                            decision: "block",
                            reason: "policy blocked",
                            additionalContext: "Use safe.ts instead.",
                        }),
                    },
                }],
                usage,
            };
        };
        const executor = createHookPromptExecutorFactory({callLLM})({
            storage,
            cwd: "/project",
            model: "fast-model",
        });
        const result = await executor.execute({
            prompt: "Reject unsafe paths",
            envelope: envelope({
                hook_event_name: "PreToolUse",
                session_id: "session",
                permission_mode: "default",
                tool_name: "edit_file",
                tool_input: {path: ".env"},
                tool_call_id: "call",
            }),
            signal: new AbortController().signal,
            timeoutMs: 1_000,
        });

        expect(result).toEqual({
            decision: "block",
            reason: "policy blocked",
            additionalContext: "Use safe.ts instead.",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[4]).toBe("fast-model");
        expect(calls[0]?.[5]).toBe("hook");
        expect(calls[0]?.[1].map((tool) => tool.function.name)).toEqual([
            "submit_hook_decision",
        ]);
        expect(calls[0]?.[0][1]?.content).toContain('"tool_name":"edit_file"');
    });

    test("拒绝普通正文、缺失提交或非法决定", async () => {
        const cases = [
            {
                message: {role: "assistant" as const, content: "looks good"},
                toolCalls: [],
            },
            {
                message: {role: "assistant" as const, content: null},
                toolCalls: [],
            },
            {
                message: {role: "assistant" as const, content: null},
                toolCalls: [{
                    id: "decision",
                    type: "function" as const,
                    function: {
                        name: "submit_hook_decision",
                        arguments: JSON.stringify({decision: "allow"}),
                    },
                }],
            },
        ];

        for (const fixture of cases) {
            const executor = createHookPromptExecutorFactory({
                callLLM: async () => ({...fixture, usage}),
            })({storage, cwd: "/project", model: "fast-model"});
            await expect(executor.execute({
                prompt: "Review",
                envelope: envelope({
                    hook_event_name: "UserPromptSubmit",
                    session_id: "session",
                    permission_mode: "default",
                    prompt: "hello",
                }),
                signal: new AbortController().signal,
                timeoutMs: 1_000,
            })).rejects.toBeInstanceOf(Error);
        }
    });

    test("内部期限报告 Prompt Hook timeout，父级取消保持取消原因", async () => {
        const callLLM: LLMCaller = async (
            _messages,
            _tools,
            _storage,
            _cwd,
            _model,
            _kind,
            signal
        ) => new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
            });
        });
        const executor = createHookPromptExecutorFactory({callLLM})({
            storage,
            cwd: "/project",
            model: "fast-model",
        });

        await expect(executor.execute({
            prompt: "Review",
            envelope: envelope({
                hook_event_name: "SessionStart",
                session_id: "session",
                source: "startup",
                model: "primary-model",
            }),
            signal: new AbortController().signal,
            timeoutMs: 5,
        })).rejects.toThrow("Prompt Hook timed out (5ms)");

        const parent = new AbortController();
        const pending = executor.execute({
            prompt: "Review",
            envelope: envelope({
                hook_event_name: "SessionEnd",
                session_id: "session",
                reason: "cancelled",
            }),
            signal: parent.signal,
            timeoutMs: 1_000,
        });
        parent.abort("parent cancelled");
        await expect(pending).rejects.toBe("parent cancelled");
    });
});
