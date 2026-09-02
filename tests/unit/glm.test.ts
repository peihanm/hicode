import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createGlmProvider,
  glmProvider,
} from "../../src/llm/providers/glm.js";
import { createOpenAICompatibleCaller } from "../../src/llm/providers/openAICompatible.js";
import { createTurnAbortController } from "../../src/runtime/abort.js";
import { createTestStorage, withTempProject } from "../helpers/tempProject.js";
import type { LLMCallOptions, LLMProvider } from "../../src/llm/types.js";
import {getProjectDebugDirectory} from "../../src/persistence/index.js";

const GLM_SOURCE = {
  id: "glm" as const,
  label: "GLM",
  apiKeyEnv: "GLM_API_KEY",
};

function callGlm(
  provider: LLMProvider,
  options: Omit<LLMCallOptions, "storage">
) {
  return provider.call({
    ...options,
    storage: createTestStorage(options.cwd),
  }, GLM_SOURCE);
}

function promptLogDirectory(cwd: string): string {
  return join(getProjectDebugDirectory(createTestStorage(cwd), cwd), "prompt-logs");
}

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GLM_API_KEY;

function createTestGlmProvider(
  config: Parameters<typeof createOpenAICompatibleCaller>[0]
) {
  return createGlmProvider(createOpenAICompatibleCaller(config));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GLM_API_KEY;
  else process.env.GLM_API_KEY = originalApiKey;
});

describe("GLM cancellation", () => {
  test("API 错误不会向用户或 Prompt Log 回显 Provider Key", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "provider-secret-token";
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
        "authorization=provider-secret-token",
        {status: 401}
      )) as typeof fetch;

      await expect(callGlm(glmProvider, {
        messages: [{role: "user", content: "hello"}],
        tools: [],
        cwd,
        model: "glm-test",
        kind: "main",
      })).rejects.toThrow("authorization=[REDACTED]");

      const files = await readdir(promptLogDirectory(cwd));
      const logged = await readFile(
        join(promptLogDirectory(cwd), files[0]!),
        "utf8"
      );
      expect(logged).not.toContain("provider-secret-token");
      expect(logged).toContain("[REDACTED]");
    });
  });

  test("用户取消 fetch 后不会进入 retry", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const controller = createTurnAbortController();
      let fetchCalls = 0;
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });

      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        started();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      }) as typeof fetch;

      const running = callGlm(glmProvider, {
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        cwd,
        model: "glm-test",
        kind: "main",
        signal: controller.signal,
      });
      await didStart;
      const pendingLogs = await readdir(promptLogDirectory(cwd));
      expect(pendingLogs).toHaveLength(1);
      const pending = JSON.parse(
        await readFile(
          join(promptLogDirectory(cwd), pendingLogs[0]!),
          "utf8"
        )
      ) as { response: unknown };
      expect(pending.response).toEqual({ status: "pending" });
      controller.abort("user-cancel");

      await expect(running).rejects.toMatchObject({
        name: "TurnInterruptedError",
        reason: "user-cancel",
      });
      expect(fetchCalls).toBe(1);
      const cancelled = JSON.parse(
        await readFile(
          join(promptLogDirectory(cwd), pendingLogs[0]!),
          "utf8"
        )
      ) as { response: { error?: string } };
      expect(cancelled.response.error).toContain("fetch 已取消");
    });
  });

  test(
    "stream 空闲超时立即失败，不重放同一个生成请求",
    async () => {
      await withTempProject(async (cwd) => {
        process.env.GLM_API_KEY = "test-token";
        let fetchCalls = 0;
        const progress: string[] = [];

        globalThis.fetch = ((_input: RequestInfo | URL) => {
          fetchCalls += 1;
          return Promise.resolve(
            new Response(new ReadableStream<Uint8Array>({ start() {} }), {
              status: 200,
            })
          );
        }) as typeof fetch;

        const provider = createTestGlmProvider({
          streamIdleTimeoutMs: 2,
          retryBaseDelayMs: 1,
        });
        await expect(
          callGlm(provider, {
            messages: [{ role: "user", content: "hello" }],
            tools: [],
            cwd,
            model: "glm-test",
            kind: "main",
            onStreamProgress: (item) => progress.push(item.phase),
          })
        ).rejects.toThrow("LLM stream 连续 2ms 没有收到数据");
        expect(fetchCalls).toBe(1);
        expect(progress).toContain("stalled");
      });
    },
    5_000
  );

  test("流式拼接文本和 Function Calling 参数并报告实时进度", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      let requestBody: Record<string, unknown> | undefined;
      const progress: Array<{
        phase: string;
        estimatedOutputTokens: number;
        toolName?: string;
      }> = [];
      const encoder = new TextEncoder();
      const events = [
        { choices: [{ delta: { content: "准备创建文件。" } }] },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"game.html\",\"con" } }] } }],
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "tent\":\"<html></html>\"}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        },
      ];

      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as typeof fetch;

      const result = await callGlm(glmProvider, {
        messages: [{ role: "user", content: "create it" }],
        tools: [],
        cwd,
        model: "glm-test",
        kind: "main",
        onStreamProgress: (item) => progress.push(item),
      });

      expect(requestBody).toMatchObject({ stream: true, tool_stream: true });
      expect(result.message.content).toBe("准备创建文件。");
      expect(result.toolCalls).toEqual([
        {
          id: "call-1",
          type: "function",
          function: {
            name: "write_file",
            arguments: '{"path":"game.html","content":"<html></html>"}',
          },
        },
      ]);
      expect(result.usage).toEqual({
        prompt_tokens: 40,
        completion_tokens: 12,
        total_tokens: 52,
      });
      expect(progress.map((item) => item.phase)).toEqual([
        "content",
        "tool_input",
        "tool_input",
      ]);
      expect(progress.at(-1)).toMatchObject({
        toolName: "write_file",
        estimatedOutputTokens: expect.any(Number),
      });
      const [promptLog] = await readdir(promptLogDirectory(cwd));
      const logged = JSON.parse(
        await readFile(join(promptLogDirectory(cwd), promptLog!), "utf8")
      ) as {
        response: Record<string, unknown>;
      };
      expect(logged.response).not.toHaveProperty("streamDiagnostics");
      expect(logged.response.rawResponse).toMatchObject({
        stream: true,
        finishReason: "tool_calls",
      });
    });
  });

  test("收到 finish_reason 后不再等待缺失的 DONE 事件", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;

      globalThis.fetch = ((_input: RequestInfo | URL) => {
        fetchCalls += 1;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: "call-without-done",
                                type: "function",
                                function: {
                                  name: "write_file",
                                  arguments:
                                    '{"path":"game.html","content":"ok"}',
                                },
                              },
                            ],
                          },
                          finish_reason: "tool_calls",
                        },
                      ],
                      usage: {
                        prompt_tokens: 20,
                        completion_tokens: 8,
                        total_tokens: 28,
                      },
                    })}\n\n`
                  )
                );
                // 模拟部分 OpenAI-compatible 中转站：工具调用已经结束，
                // 但连接没有关闭，也没有补发 data: [DONE]。
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({
        streamIdleTimeoutMs: 100,
        outputStallTimeoutMs: 20,
        retryBaseDelayMs: 1,
      });
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "create game" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(fetchCalls).toBe(1);
      expect(result.toolCalls).toEqual([
        {
          id: "call-without-done",
          type: "function",
          function: {
            name: "write_file",
            arguments: '{"path":"game.html","content":"ok"}',
          },
        },
      ]);
      expect(result.usage.total_tokens).toBe(28);
    });
  });

  test("完全空响应可以安全重试且不会作为 assistant 消息返回", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;

      globalThis.fetch = ((_input: RequestInfo | URL) => {
        fetchCalls += 1;
        const event = fetchCalls === 1
          ? {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 8,
                completion_tokens: 0,
                total_tokens: 8,
              },
            }
          : {
              choices: [{ delta: { content: "恢复成功" }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 8,
                completion_tokens: 2,
                total_tokens: 10,
              },
            };
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({ retryBaseDelayMs: 1 });
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "continue" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(fetchCalls).toBe(2);
      expect(result.message.content).toBe("恢复成功");
      expect(result.usage).toEqual({
        prompt_tokens: 16,
        completion_tokens: 2,
        total_tokens: 18,
      });
      expect(result.contextUsage).toEqual({tokenCount: 10});
      const logs = (await readdir(promptLogDirectory(cwd))).sort();
      expect(logs).toHaveLength(2);
      const first = JSON.parse(
        await readFile(join(promptLogDirectory(cwd), logs[0]!), "utf8")
      ) as { response: { error?: string } };
      expect(first.response.error).toContain("API 返回空响应 (attempt 1/3");
    });
  });

  test("只有空白文本和空白推理时也按空响应重试", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;

      globalThis.fetch = ((_input: RequestInfo | URL) => {
        fetchCalls += 1;
        const event = fetchCalls === 1
          ? {
              choices: [{
                delta: { content: "  \n", reasoning_content: " \t" },
                finish_reason: "stop",
              }],
            }
          : {
              choices: [{ delta: { content: "恢复成功" }, finish_reason: "stop" }],
            };
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({ retryBaseDelayMs: 1 });
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "continue" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(fetchCalls).toBe(2);
      expect(result.message.content).toBe("恢复成功");
    });
  });

  test("空响应重试耗尽后明确失败", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;
      globalThis.fetch = ((_input: RequestInfo | URL) => {
        fetchCalls += 1;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
                  )
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({ retryBaseDelayMs: 1 });
      await expect(
        callGlm(provider, {
          messages: [{ role: "user", content: "continue" }],
          tools: [],
          cwd,
          model: "glm-5.2",
          kind: "main",
        })
      ).rejects.toThrow(
        "LLM 返回空响应（已尝试 3 次）：没有正文、推理内容或工具调用"
      );
      expect(fetchCalls).toBe(3);
      expect(
        await readdir(promptLogDirectory(cwd))
      ).toHaveLength(3);
    });
  });

  test("GLM 开启 thinking 并让服务端决定推理强度", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const requestBodies: Array<Record<string, unknown>> = [];
      const encoder = new TextEncoder();

      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as typeof fetch;

      await callGlm(glmProvider, {
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(requestBodies[0]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[0]?.reasoning_effort).toBeUndefined();
      expect(requestBodies).toHaveLength(1);
    });
  });

  test("GLM-4.7 保留 thinking 与工具流", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      let requestBody: Record<string, unknown> = {};
      const encoder = new TextEncoder();

      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as typeof fetch;

      await callGlm(glmProvider, {
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        cwd,
        model: "glm-4.7",
        kind: "main",
      });

      expect(requestBody.thinking).toEqual({ type: "enabled" });
      expect(requestBody.tool_stream).toBe(true);
      expect(requestBody.reasoning_effort).toBeUndefined();
    });
  });

  test("第一次输出停滞会保留原参数安全重试", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;
      const requestBodies: Array<Record<string, unknown>> = [];
      const progress: string[] = [];
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (fetchCalls === 1) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "开始推理" } }] })}\n\n`
                )
              );
              return;
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "重试成功" }, finish_reason: "stop" }] })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as typeof fetch;

      const provider = createTestGlmProvider({
        streamIdleTimeoutMs: 100,
        outputStallTimeoutMs: 20,
        retryBaseDelayMs: 1_000,
      });
      const startedAt = Date.now();
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "continue after stall" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
        onStreamProgress: (item) => progress.push(item.phase),
      });

      expect(fetchCalls).toBe(2);
      expect(requestBodies[0]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[1]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[0]?.reasoning_effort).toBeUndefined();
      expect(requestBodies[1]?.reasoning_effort).toBeUndefined();
      expect(result.message.content).toBe("重试成功");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(progress).toContain("stalled");
      expect(progress).toContain("retrying");
      const logs = (await readdir(promptLogDirectory(cwd))).sort();
      expect(logs).toHaveLength(2);
      const logged = JSON.parse(
        await readFile(join(promptLogDirectory(cwd), logs[0]!), "utf8")
      ) as {
        response: {
          error?: string;
        };
      };
      expect(logged.response.error).toContain(
        "模型输出连续 20ms 没有新增量，将按原参数安全重试一次"
      );
      expect(logged.response).not.toHaveProperty("streamDiagnostics");
    });
  });

  test("连续两次输出停滞后第三次关闭深度推理", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;
      const requestBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (fetchCalls < 3) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "开始后卡住" } }] })}\n\n`
                    )
                  );
                  return;
                }
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: "降级成功" }, finish_reason: "stop" }] })}\n\n`
                  )
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({
        streamIdleTimeoutMs: 100,
        outputStallTimeoutMs: 20,
        retryBaseDelayMs: 1,
      });
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "degrade after two stalls" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(fetchCalls).toBe(3);
      expect(requestBodies[0]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[1]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[2]?.thinking).toEqual({ type: "disabled" });
      expect(requestBodies[2]?.reasoning_effort).toBeUndefined();
      expect(result.message.content).toBe("降级成功");
    });
  });

  test("关闭深度推理后仍停滞时明确失败", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      let fetchCalls = 0;
      const requestBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "开始后卡住" } }] })}\n\n`
                  )
                );
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({
        streamIdleTimeoutMs: 100,
        outputStallTimeoutMs: 20,
        retryBaseDelayMs: 1,
      });
      await expect(
        callGlm(provider, {
          messages: [{ role: "user", content: "stall twice" }],
          tools: [],
          cwd,
          model: "glm-5.2",
          kind: "main",
        })
      ).rejects.toThrow(
        "LLM 输出连续 20ms 没有新增量，关闭深度推理重试后仍无进展"
      );
      expect(fetchCalls).toBe(3);
      expect(requestBodies[0]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[1]?.thinking).toEqual({ type: "enabled" });
      expect(requestBodies[2]?.thinking).toEqual({ type: "disabled" });
      expect(requestBodies[2]?.reasoning_effort).toBeUndefined();
    });
  });

  test("reasoning 持续到达时可以超过停滞窗口", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      globalThis.fetch = ((_input: RequestInfo | URL) => {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const delay of [0, 10, 20, 30, 40]) {
                  setTimeout(() => {
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "持续" } }] })}\n\n`
                      )
                    );
                  }, delay);
                }
                setTimeout(() => {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { content: "完成" }, finish_reason: "stop" }] })}\n\n`
                    )
                  );
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                }, 50);
              },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const provider = createTestGlmProvider({
        streamIdleTimeoutMs: 100,
        outputStallTimeoutMs: 20,
      });
      const startedAt = Date.now();
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "keep thinking" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
      expect(result.message.content).toBe("完成");
    });
  });

  test("总生成时间可超过 timeout，只要相邻流事件没有空闲超时", async () => {
    await withTempProject(async (cwd) => {
      process.env.GLM_API_KEY = "test-token";
      const encoder = new TextEncoder();
      globalThis.fetch = ((_input: RequestInfo | URL) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (delay: number, value: unknown) =>
              setTimeout(
                () => controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
                ),
                delay
              );
            send(0, { choices: [{ delta: { content: "a" } }] });
            send(75, { choices: [{ delta: { content: "b" } }] });
            send(150, { choices: [{ delta: { content: "c" } }] });
            send(225, { choices: [{ delta: { content: "d" } }] });
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: {}, finish_reason: "stop" }],
                    usage: {
                      prompt_tokens: 5,
                      completion_tokens: 4,
                      total_tokens: 9,
                    },
                  })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }, 300);
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }) as typeof fetch;

      const provider = createTestGlmProvider({ streamIdleTimeoutMs: 200 });
      const startedAt = Date.now();
      const result = await callGlm(provider, {
        messages: [{ role: "user", content: "slow output" }],
        tools: [],
        cwd,
        model: "glm-test",
        kind: "main",
      });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(result.message.content).toBe("abcd");
    });
  });
});
