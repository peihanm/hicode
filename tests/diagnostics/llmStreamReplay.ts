import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {loadEnv} from "../../src/cli/env.js";
import {consumeOpenAICompatibleSSE} from "../../src/llm/providers/openAICompatibleStream.js";
import type {LLMProviderName} from "../../src/llm/providerRegistry.js";
import {loadPillarSettings} from "../../src/settings/index.js";
import type {LLMStreamProgress} from "../../src/llm/types.js";

interface PromptLogDocument {
    model?: string;
    request?: Record<string, unknown>;
}

interface DiagnosticOptions {
    promptLogPath: string;
    stallTimeoutMs: number;
}

interface RawStreamState {
    byteChunks: number;
    bytes: number;
    dataEvents: number;
    invalidEvents: number;
    outputCharacters: number;
    reasoningCharacters: number;
    contentCharacters: number;
    toolArgumentCharacters: number;
    lastByteAt?: number;
    lastDataAt?: number;
    lastOutputAt?: number;
    finishReason?: string;
}

interface ReplayConnection {
    apiKeyVariable: string;
    apiKey?: string;
    baseUrl: string;
}

const USAGE = [
    "用法：",
    "  bun tests/diagnostics/llmStreamReplay.ts --prompt-log <path> [--stall-ms 180000]",
    "",
    "该诊断只发起一次真实请求，复用 Prompt Log 中的完整 request。",
    "它同时观察原始 SSE 与 Pillar parser，不会打印 API Key、完整 Prompt 或模型输出。",
].join("\n");

function getReplayConnection(provider: LLMProviderName): ReplayConnection {
    switch (provider) {
        case "glm":
            return {
                apiKeyVariable: "GLM_API_KEY",
                apiKey: process.env.GLM_API_KEY,
                baseUrl:
                    process.env.GLM_BASE_URL ||
                    "https://open.bigmodel.cn/api/paas/v4",
            };
        case "qwen":
            return {
                apiKeyVariable: "DASHSCOPE_API_KEY",
                apiKey: process.env.DASHSCOPE_API_KEY,
                baseUrl:
                    process.env.QWEN_BASE_URL ||
                    "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            };
        case "deepseek":
            return {
                apiKeyVariable: "DEEPSEEK_API_KEY",
                apiKey: process.env.DEEPSEEK_API_KEY,
                baseUrl:
                    process.env.DEEPSEEK_BASE_URL ||
                    "https://api.deepseek.com",
            };
        case "jeniya":
            return {
                apiKeyVariable: "JENIYA_API_KEY",
                apiKey: process.env.JENIYA_API_KEY,
                baseUrl:
                    process.env.JENIYA_BASE_URL || "https://jeniya.cn/v1",
            };
    }
}

function parsePositiveInteger(raw: string | undefined, name: string): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} 必须是正整数`);
    }
    return value;
}

function parseOptions(argv: readonly string[]): DiagnosticOptions {
    let promptLogPath: string | undefined;
    let stallTimeoutMs = 180_000;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--prompt-log") {
            promptLogPath = argv[index + 1];
            index += 1;
            continue;
        }
        if (argument === "--stall-ms") {
            stallTimeoutMs = parsePositiveInteger(
                argv[index + 1],
                "--stall-ms"
            );
            index += 1;
            continue;
        }
        if (argument === "--help" || argument === "-h") {
            console.log(USAGE);
            process.exit(0);
        }
        throw new Error(`未知参数: ${argument ?? "<empty>"}`);
    }
    if (!promptLogPath) throw new Error("缺少 --prompt-log");
    return {
        promptLogPath: resolve(promptLogPath),
        stallTimeoutMs,
    };
}

function projectCwdFromPromptLog(path: string): string {
    return resolve(dirname(path), "../..");
}

function completionsUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith("/chat/completions")
        ? normalized
        : `${normalized}/chat/completions`;
}

function elapsed(startedAt: number, timestamp = Date.now()): string {
    return `${((timestamp - startedAt) / 1000).toFixed(1)}s`;
}

function eventData(event: string): string | undefined {
    const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    return data || undefined;
}

function inspectDataEvent(data: string, state: RawStreamState): void {
    state.dataEvents += 1;
    state.lastDataAt = Date.now();
    if (data === "[DONE]") return;
    try {
        const chunk = JSON.parse(data) as {
            choices?: Array<{
                delta?: {
                    reasoning_content?: string | null;
                    content?: string | null;
                    tool_calls?: Array<{
                        function?: {arguments?: string};
                    }>;
                };
                finish_reason?: string | null;
            }>;
        };
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) state.finishReason = choice.finish_reason;
        const reasoning = choice?.delta?.reasoning_content ?? "";
        const content = choice?.delta?.content ?? "";
        const toolArguments = (choice?.delta?.tool_calls ?? []).reduce(
            (total, call) => total + (call.function?.arguments?.length ?? 0),
            0
        );
        const output = reasoning.length + content.length + toolArguments;
        state.reasoningCharacters += reasoning.length;
        state.contentCharacters += content.length;
        state.toolArgumentCharacters += toolArguments;
        state.outputCharacters += output;
        if (output > 0) state.lastOutputAt = Date.now();
    } catch {
        state.invalidEvents += 1;
    }
}

function createObservedBody(
    source: ReadableStream<Uint8Array>,
    state: RawStreamState
): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let buffer = "";
    return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            state.byteChunks += 1;
            state.bytes += chunk.byteLength;
            state.lastByteAt = Date.now();
            buffer += decoder.decode(chunk, {stream: true});
            let boundary = buffer.search(/\r?\n\r?\n/);
            while (boundary >= 0) {
                const event = buffer.slice(0, boundary);
                const separator = buffer.slice(boundary)
                    .match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
                buffer = buffer.slice(boundary + separator.length);
                const data = eventData(event);
                if (data) inspectDataEvent(data, state);
                boundary = buffer.search(/\r?\n\r?\n/);
            }
            controller.enqueue(chunk);
        },
        flush() {
            buffer += decoder.decode();
            const data = eventData(buffer);
            if (data) inspectDataEvent(data, state);
        },
    }));
}

function printSummary({
    startedAt,
    state,
    parsedProgress,
    completed,
    error,
}: {
    startedAt: number;
    state: RawStreamState;
    parsedProgress?: LLMStreamProgress;
    completed: boolean;
    error?: unknown;
}): void {
    const rawIdleMs = state.lastOutputAt
        ? Date.now() - state.lastOutputAt
        : undefined;
    const parserCharacters = parsedProgress?.outputCharacters ?? 0;
    console.log("\n诊断摘要");
    console.log(`- 总时长: ${elapsed(startedAt)}`);
    console.log(`- 原始传输: ${state.byteChunks} chunks / ${state.bytes} bytes / ${state.dataEvents} SSE data events`);
    console.log(`- 原始有效输出: ${state.outputCharacters} chars（reasoning ${state.reasoningCharacters}, content ${state.contentCharacters}, tool arguments ${state.toolArgumentCharacters}）`);
    console.log(`- Pillar parser 有效输出: ${parserCharacters} chars`);
    console.log(`- finish_reason: ${state.finishReason ?? "未收到"}`);
    if (state.lastByteAt) {
        console.log(`- 最后原始字节: ${elapsed(startedAt, state.lastByteAt)}`);
    }
    if (state.lastOutputAt) {
        console.log(`- 最后有效输出: ${elapsed(startedAt, state.lastOutputAt)}（已空闲 ${Math.round((rawIdleMs ?? 0) / 1000)}s）`);
    }
    if (state.invalidEvents > 0) {
        console.log(`- 无法解析的 SSE data events: ${state.invalidEvents}`);
    }
    if (error) {
        console.log(`- 结束错误: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("\n判断");
    if (state.outputCharacters > parserCharacters) {
        console.log("- 原始 SSE 含有 Pillar parser 未消费的有效增量：优先排查 Pillar 流解析。 ");
    } else if (completed) {
        console.log("- 同一 payload 已完整跑通，且原始 SSE 与 parser 计数一致：更像上游偶发停滞，而不是稳定的 Pillar 解析错误。");
    } else if (!state.finishReason && state.outputCharacters === parserCharacters) {
        console.log("- 原始 SSE 和 Pillar parser 在同一点停止，且上游没有发送 finish_reason：停滞发生在模型或中转站，不是 TUI 刷新丢数据。");
    } else {
        console.log("- 原始流已经给出完成信号但 Pillar 未完成：优先排查 Pillar 的完成/取消边界。");
    }
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const projectCwd = projectCwdFromPromptLog(options.promptLogPath);
    process.chdir(projectCwd);
    loadEnv();
    const settings = loadPillarSettings(projectCwd);
    const document = JSON.parse(
        await readFile(options.promptLogPath, "utf8")
    ) as PromptLogDocument;
    if (!document.request || !Array.isArray(document.request.messages)) {
        throw new Error("Prompt Log 缺少可重放的 request.messages");
    }
    const model = typeof document.request.model === "string"
        ? document.request.model
        : document.model;
    if (!model) throw new Error("Prompt Log 缺少 model");
    const provider = settings.values.models.primary.provider;
    const connection = getReplayConnection(provider);
    if (!connection.apiKey) {
        throw new Error(`缺少 ${connection.apiKeyVariable}`);
    }
    const url = completionsUrl(connection.baseUrl);
    const request = {...document.request, model, stream: true};
    const startedAt = Date.now();
    const controller = new AbortController();
    const state: RawStreamState = {
        byteChunks: 0,
        bytes: 0,
        dataEvents: 0,
        invalidEvents: 0,
        outputCharacters: 0,
        reasoningCharacters: 0,
        contentCharacters: 0,
        toolArgumentCharacters: 0,
    };
    let parsedProgress: LLMStreamProgress | undefined;
    let lastPrintedTokenBucket = -1;
    let completed = false;
    let caught: unknown;

    console.log("LLM stream replay diagnostic");
    console.log(`project: ${projectCwd}`);
    console.log(`prompt log: ${options.promptLogPath}`);
    console.log(`provider: ${provider}`);
    console.log(`model: ${model}`);
    console.log(`output stall observation: ${options.stallTimeoutMs}ms`);
    console.log("API Key、完整 Prompt 和模型正文不会输出。\n");

    const watchdog = setInterval(() => {
        const reference = state.lastOutputAt ?? startedAt;
        const idleMs = Date.now() - reference;
        if (idleMs >= options.stallTimeoutMs) {
            controller.abort(new Error(
                `诊断观察到连续 ${options.stallTimeoutMs}ms 没有有效输出`
            ));
        }
    }, 250);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${connection.apiKey}`,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
        });
        console.log(`HTTP ${response.status} · first headers ${elapsed(startedAt)}`);
        if (!response.ok) {
            throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        if (!response.body) throw new Error("响应缺少 stream body");
        const result = await consumeOpenAICompatibleSSE({
            body: createObservedBody(response.body, state),
            signal: controller.signal,
            onActivity() {},
            onProgress(progress) {
                parsedProgress = progress;
                const bucket = Math.floor(progress.estimatedOutputTokens / 250);
                if (bucket > lastPrintedTokenBucket) {
                    lastPrintedTokenBucket = bucket;
                    console.log(
                        `${elapsed(startedAt)} parser ${progress.phase} · ~${progress.estimatedOutputTokens} tokens · raw ${state.dataEvents} events`
                    );
                }
            },
        });
        completed = true;
        console.log(`${elapsed(startedAt)} completed · finish=${result.finishReason ?? "missing"} · tool calls=${result.toolCalls.length}`);
    } catch (error) {
        caught = error;
    } finally {
        clearInterval(watchdog);
    }

    printSummary({
        startedAt,
        state,
        parsedProgress,
        completed,
        ...(caught ? {error: caught} : {}),
    });
    if (caught) process.exitCode = 2;
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
});
