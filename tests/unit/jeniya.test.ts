import { afterEach, describe, expect, test } from "bun:test";
import { createLLMCaller } from "../../src/llm/index.js";
import { jeniyaProvider } from "../../src/llm/providers/jeniya.js";
import { withTempProject } from "../helpers/tempProject.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.JENIYA_API_KEY;
const originalBaseUrl = process.env.JENIYA_BASE_URL;
const originalReasoningEffort = process.env.PILLAR_REASONING_EFFORT;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("JENIYA_API_KEY", originalApiKey);
  restoreEnv("JENIYA_BASE_URL", originalBaseUrl);
  restoreEnv("PILLAR_REASONING_EFFORT", originalReasoningEffort);
});

function successfulStream(content = "ok"): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { content }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 5,
                completion_tokens: 1,
                total_tokens: 6,
              },
            })}\n\n`
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200 }
  );
}

describe("Jeniya OpenAI-compatible provider", () => {
  test("接受任意模型并以标准 OpenAI 格式调用默认中转地址", async () => {
    await withTempProject(async (cwd) => {
      process.env.JENIYA_API_KEY = "relay-token";
      delete process.env.JENIYA_BASE_URL;
      let requestedUrl = "";
      let authorization = "";
      let requestBody: Record<string, unknown> = {};

      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(successfulStream("relay ok"));
      }) as typeof fetch;

      const result = await createLLMCaller("jeniya")(
        [{ role: "user", content: "hello" }],
        [],
        cwd,
        "gpt-5-chat-latest",
        "main"
      );

      expect(jeniyaProvider.supports("any-model-name")).toBe(true);
      expect(requestedUrl).toBe("https://jeniya.cn/v1/chat/completions");
      expect(authorization).toBe("Bearer relay-token");
      expect(requestBody).toMatchObject({
        model: "gpt-5-chat-latest",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(requestBody.tools).toBeUndefined();
      expect(requestBody.thinking).toBeUndefined();
      expect(requestBody.tool_stream).toBeUndefined();
      expect(result.message.content).toBe("relay ok");
    });
  });

  test("GLM 模型自动携带已验证的 thinking 与 tool_stream 扩展", async () => {
    await withTempProject(async (cwd) => {
      process.env.JENIYA_API_KEY = "relay-token";
      process.env.JENIYA_BASE_URL = "https://relay.example/v1/";
      delete process.env.PILLAR_REASONING_EFFORT;
      let requestedUrl = "";
      let requestBody: Record<string, unknown> = {};

      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(successfulStream());
      }) as typeof fetch;

      await jeniyaProvider.call({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        cwd,
        model: "glm-5.2",
        kind: "main",
      });

      expect(requestedUrl).toBe("https://relay.example/v1/chat/completions");
      expect(requestBody).toMatchObject({
        model: "glm-5.2",
        stream: true,
        tool_stream: true,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        stream_options: { include_usage: true },
      });
    });
  });

  test("缺少 Jeniya Key 时给出明确配置错误", async () => {
    await withTempProject(async (cwd) => {
      delete process.env.JENIYA_API_KEY;
      await expect(
        jeniyaProvider.call({
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          cwd,
          model: "glm-5.2",
          kind: "main",
        })
      ).rejects.toThrow("缺少 JENIYA_API_KEY");
    });
  });
});
