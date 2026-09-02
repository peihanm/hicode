import {describe, expect, test} from "bun:test";
import {consumeOpenAICompatibleSSE} from "../../src/llm/providers/openAICompatibleStream.js";

function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

describe("OpenAI-compatible stream consumption", () => {
    test("SSE heartbeat 只报告传输活动，不伪造模型输出进度", async () => {
        let activity = 0;
        const progress: string[] = [];
        const result = await consumeOpenAICompatibleSSE({
            body: streamFromChunks([
                ": keep-alive\n\n",
                `data: ${JSON.stringify({
                    choices: [{
                        delta: {content: "done"},
                        finish_reason: "stop",
                    }],
                })}\n\n`,
                "data: [DONE]\n\n",
            ]),
            signal: new AbortController().signal,
            onActivity() {
                activity += 1;
            },
            onProgress(item) {
                progress.push(item.phase);
            },
        });

        expect(result.content).toBe("done");
        expect(activity).toBe(3);
        expect(progress).toEqual(["content"]);
    });

    test("跨原始分块拼接推理、正文、工具参数并识别 DONE", async () => {
        const payload = [
            `data: ${JSON.stringify({choices: [{delta: {role: "assistant"}}]})}\n\n`,
            `data: ${JSON.stringify({choices: [{delta: {reasoning_content: "secret reasoning"}}]})}\n\n`,
            `data: ${JSON.stringify({choices: [{delta: {content: "secret content"}}]})}\n\n`,
            `data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: "call-1", type: "function", function: {name: "write_file", arguments: "{\\\"path\\\":\\\"x\\\"}"}}]}, finish_reason: "tool_calls"}]})}\n\n`,
            "data: [DONE]\n\n",
        ].join("");
        const first = Math.floor(payload.length / 3);
        const second = Math.floor(payload.length * 2 / 3);
        const result = await consumeOpenAICompatibleSSE({
            body: streamFromChunks([
                payload.slice(0, first),
                payload.slice(first, second),
                payload.slice(second),
            ]),
            signal: new AbortController().signal,
            onActivity() {},
        });

        expect(result.content).toBe("secret content");
        expect(result.reasoningContent).toBe("secret reasoning");
        expect(result.toolCalls[0]?.function.name).toBe("write_file");
    });

    test("finish_reason 后继续读取独立 usage 尾包", async () => {
        let completionSignals = 0;
        const result = await consumeOpenAICompatibleSSE({
            body: streamFromChunks([
                `data: ${JSON.stringify({choices: [{delta: {content: "done"}, finish_reason: "stop"}], usage: null})}\n\n`,
                `data: ${JSON.stringify({choices: [], usage: {prompt_tokens: 9, completion_tokens: 3, total_tokens: 12}})}\n\n`,
                "data: [DONE]\n\n",
            ]),
            signal: new AbortController().signal,
            onActivity() {},
            onCompletionSignal() {
                completionSignals += 1;
            },
        });

        expect(completionSignals).toBe(1);
        expect(result.finishReason).toBe("stop");
        expect(result.usage).toEqual({
            prompt_tokens: 9,
            completion_tokens: 3,
            total_tokens: 12,
        });
    });

    test("未知字段不影响解析，等待中的流仍响应取消", async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(streamController) {
                streamController.enqueue(encoder.encode(
                    `data: ${JSON.stringify({choices: [{delta: {unknown_field: "not stored"}}]})}\n\n`
                ));
            },
        });
        setTimeout(() => controller.abort(new Error("diagnostic stop")), 5);

        await expect(consumeOpenAICompatibleSSE({
            body,
            signal: controller.signal,
            onActivity() {},
        })).rejects.toThrow("diagnostic stop");
    });

    test("连接在 finish_reason 前结束时拒绝可能截断的工具调用", async () => {
        await expect(consumeOpenAICompatibleSSE({
            body: streamFromChunks([
                `data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: "call-1", type: "function", function: {name: "write_file", arguments: "{\\\"path\\\":\\\"x\\\"}"}}]}}]})}\n\n`,
            ]),
            signal: new AbortController().signal,
            onActivity() {},
        })).rejects.toThrow("在明确完成前已结束");
    });

    test("工具调用必须由 tool_calls 完成原因确认", async () => {
        await expect(consumeOpenAICompatibleSSE({
            body: streamFromChunks([
                `data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: "call-1", type: "function", function: {name: "read_file", arguments: "{\\\"path\\\":\\\"x\\\"}"}}]}, finish_reason: "stop"}]})}\n\n`,
                "data: [DONE]\n\n",
            ]),
            signal: new AbortController().signal,
            onActivity() {},
        })).rejects.toThrow("与工具调用不一致");
    });

    test("拒绝非法 usage，避免污染 token 状态", async () => {
        await expect(consumeOpenAICompatibleSSE({
            body: streamFromChunks([
                `data: ${JSON.stringify({choices: [{delta: {content: "done"}, finish_reason: "stop"}], usage: {prompt_tokens: "9", completion_tokens: 3, total_tokens: 12}})}\n\n`,
            ]),
            signal: new AbortController().signal,
            onActivity() {},
        })).rejects.toThrow("usage.prompt_tokens");
    });
});
