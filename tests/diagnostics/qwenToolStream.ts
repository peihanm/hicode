import {loadEnv} from "../../src/cli/env.js";
import {createGlmRequestFields} from "../../src/llm/providers/glm.js";

interface ProbeOptions {
    compareGlm: boolean;
    glmOnly: boolean;
    timeoutMs: number;
}

interface ProbeConfig {
    label: "Qwen" | "GLM";
    apiKey: string;
    baseUrl: string;
    model: string;
    requestFields: Record<string, unknown>;
}

interface StreamToolCallDelta {
    index?: number;
    id?: string;
    type?: string;
    function?: {
        name?: string | null;
        arguments?: string | null;
    };
}

interface StreamChunk {
    choices?: Array<{
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: StreamToolCallDelta[] | null;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    } | null;
}

interface ToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
}

interface ProbeResult {
    label: string;
    model: string;
    durationMs: number;
    firstEventMs?: number;
    firstToolDeltaMs?: number;
    sseEvents: number;
    toolDeltaEvents: number;
    argumentFragments: number;
    argumentCharacters: number;
    contentCharacters: number;
    reasoningCharacters: number;
    finishReason?: string;
    doneReceived: boolean;
    toolCalls: ToolCallAccumulator[];
    argumentsAreValidJson: boolean;
    toolCallMatchesProbe: boolean;
    usage?: StreamChunk["usage"];
}

const DEFAULT_BASE_URL =
    "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_QWEN_MODEL = "qwen3.6-plus";
const DEFAULT_GLM_MODEL = "glm-5.2";
const DEFAULT_TIMEOUT_MS = 120_000;

const TOOL_NAME = "record_stream_probe";
const PROBE_SEGMENTS = Array.from(
    {length: 20},
    (_, index) => `segment-${String(index + 1).padStart(2, "0")}-abcdefghijklmnop`
).join("|");

const TOOLS = [
    {
        type: "function",
        function: {
            name: TOOL_NAME,
            description:
                "记录工具参数流式传输诊断数据。用户要求诊断时必须调用此工具。",
            parameters: {
                type: "object",
                properties: {
                    message: {
                        type: "string",
                        description: "原样保存用户提供的诊断字符串。",
                    },
                    sequence: {
                        type: "integer",
                        description: "固定填写 1。",
                    },
                },
                required: ["message", "sequence"],
                additionalProperties: false,
            },
        },
    },
];

const USAGE = [
    "Usage:",
    "  bun tests/diagnostics/qwenToolStream.ts",
    "  bun tests/diagnostics/qwenToolStream.ts --compare-glm",
    "  bun tests/diagnostics/qwenToolStream.ts --glm-only",
    "  bun tests/diagnostics/qwenToolStream.ts --timeout-ms 180000",
    "",
    "环境变量：",
    "  DASHSCOPE_API_KEY   Qwen 模式必填；百炼 API Key",
    `  QWEN_BASE_URL       可选；默认 ${DEFAULT_BASE_URL}`,
    `  QWEN_PROBE_MODEL    可选；默认 ${DEFAULT_QWEN_MODEL}`,
    `  GLM_API_KEY         GLM 对照时必填；智谱 API Key`,
    `  GLM_BASE_URL        可选；默认 ${DEFAULT_GLM_BASE_URL}`,
    `  GLM_COMPARE_MODEL   可选；默认 ${DEFAULT_GLM_MODEL}`,
    "",
    "--compare-glm 会通过智谱官方接口追加一次 GLM 对照请求。",
    "脚本只打印工具参数片段的长度与短预览，不打印 API Key。",
].join("\n");

function parsePositiveInteger(raw: string | undefined, name: string): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} 必须是正整数`);
    }
    return value;
}

function parseOptions(argv: readonly string[]): ProbeOptions {
    let compareGlm = false;
    let glmOnly = false;
    let timeoutMs = DEFAULT_TIMEOUT_MS;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--compare-glm") {
            compareGlm = true;
            continue;
        }
        if (argument === "--glm-only") {
            glmOnly = true;
            continue;
        }
        if (argument === "--timeout-ms") {
            timeoutMs = parsePositiveInteger(
                argv[index + 1],
                "--timeout-ms"
            );
            index += 1;
            continue;
        }
        if (argument === "--help" || argument === "-h") {
            console.log(USAGE);
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${argument ?? "<empty>"}`);
    }

    if (compareGlm && glmOnly) {
        throw new Error("--compare-glm 和 --glm-only 不能同时使用");
    }
    return {compareGlm, glmOnly, timeoutMs};
}

function completionsUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith("/chat/completions")
        ? normalized
        : `${normalized}/chat/completions`;
}

function appendToolName(current: string, fragment: string): string {
    if (!current) return fragment;
    if (fragment === current || current.endsWith(fragment)) return current;
    if (fragment.startsWith(current)) return fragment;
    if (current.startsWith(fragment)) return current;
    return current + fragment;
}

function eventData(event: string): string | undefined {
    const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    return data || undefined;
}

async function* readSseData(
    body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            buffer += decoder.decode(part.value, {stream: true});
            let boundary = buffer.search(/\r?\n\r?\n/);
            while (boundary >= 0) {
                const event = buffer.slice(0, boundary);
                const separator =
                    buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ??
                    "\n\n";
                buffer = buffer.slice(boundary + separator.length);
                const data = eventData(event);
                if (data) yield data;
                boundary = buffer.search(/\r?\n\r?\n/);
            }
        }
        buffer += decoder.decode();
        const data = eventData(buffer);
        if (data) yield data;
    } finally {
        reader.releaseLock();
    }
}

function preview(fragment: string): string {
    const compact = fragment.replace(/\s+/g, " ");
    const visible = compact.length > 48
        ? `${compact.slice(0, 48)}…`
        : compact;
    return JSON.stringify(visible);
}

function elapsed(startedAt: number): string {
    return `${((Date.now() - startedAt) / 1000).toFixed(3)}s`;
}

function createRequestBody(config: ProbeConfig): Record<string, unknown> {
    return {
        ...config.requestFields,
        model: config.model,
        messages: [
            {
                role: "system",
                content:
                    "只调用指定工具，不要输出解释、Markdown 或普通文本。工具参数必须严格使用用户给出的值。",
            },
            {
                role: "user", origin: "user" as const,
                content: `请调用 ${TOOL_NAME}，sequence 填 1，message 原样填写以下字符串：${PROBE_SEGMENTS}`,
            },
        ],
        tools: TOOLS,
        stream: true,
        stream_options: {include_usage: true},
    };
}

async function runProbe(
    config: ProbeConfig,
    timeoutMs: number
): Promise<ProbeResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new Error(`${config.label} Request did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    console.log(`\n[${config.label}] POST ${completionsUrl(config.baseUrl)}`);
    console.log(`[${config.label}] model=${config.model}`);
    console.log(
        `[${config.label}] request extensions=${JSON.stringify(config.requestFields)}`
    );

    try {
        const response = await fetch(completionsUrl(config.baseUrl), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(createRequestBody(config)),
            signal: controller.signal,
        });
        if (!response.ok) {
            const details = (await response.text()).slice(0, 1_000);
            throw new Error(
                `${config.label} API ${response.status}: ${details || response.statusText}`
            );
        }
        if (!response.body) {
            throw new Error(`${config.label} 响应缺少 stream body`);
        }

        const tools = new Map<number, ToolCallAccumulator>();
        let firstEventMs: number | undefined;
        let firstToolDeltaMs: number | undefined;
        let sseEvents = 0;
        let toolDeltaEvents = 0;
        let argumentFragments = 0;
        let argumentCharacters = 0;
        let contentCharacters = 0;
        let reasoningCharacters = 0;
        let finishReason: string | undefined;
        let doneReceived = false;
        let usage: StreamChunk["usage"];

        for await (const data of readSseData(response.body)) {
            sseEvents += 1;
            firstEventMs ??= Date.now() - startedAt;
            if (data === "[DONE]") {
                doneReceived = true;
                console.log(`[${config.label} ${elapsed(startedAt)}] [DONE]`);
                continue;
            }

            let chunk: StreamChunk;
            try {
                chunk = JSON.parse(data) as StreamChunk;
            } catch (error) {
                throw new Error(
                    `${config.label} 返回无效 SSE JSON: ${error instanceof Error ? error.message : String(error)}`
                );
            }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta;
            contentCharacters += delta?.content?.length ?? 0;
            reasoningCharacters += delta?.reasoning_content?.length ?? 0;

            for (const streamed of delta?.tool_calls ?? []) {
                firstToolDeltaMs ??= Date.now() - startedAt;
                toolDeltaEvents += 1;
                const index = streamed.index ?? 0;
                const current = tools.get(index) ?? {
                    id: "",
                    name: "",
                    arguments: "",
                };
                if (streamed.id) current.id = streamed.id;
                const nameFragment = streamed.function?.name ?? "";
                if (nameFragment) {
                    current.name = appendToolName(current.name, nameFragment);
                }
                const argumentFragment = streamed.function?.arguments ?? "";
                if (argumentFragment) {
                    argumentFragments += 1;
                    argumentCharacters += argumentFragment.length;
                    current.arguments += argumentFragment;
                }
                tools.set(index, current);
                console.log(
                    `[${config.label} ${elapsed(startedAt)}] tool[${index}]` +
                    ` id=${streamed.id ? "yes" : "-"}` +
                    ` name=${nameFragment ? JSON.stringify(nameFragment) : "-"}` +
                    ` args+=${argumentFragment.length}` +
                    `${argumentFragment ? ` ${preview(argumentFragment)}` : ""}`
                );
            }
        }

        const toolCalls = [...tools.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, toolCall]) => toolCall);
        const argumentsAreValidJson =
            toolCalls.length > 0 &&
            toolCalls.every((toolCall) => {
                try {
                    JSON.parse(toolCall.arguments);
                    return true;
                } catch {
                    return false;
                }
            });
        const toolCallMatchesProbe =
            toolCalls.length === 1 &&
            toolCalls[0]?.name === TOOL_NAME &&
            (() => {
                try {
                    const input = JSON.parse(toolCalls[0].arguments) as {
                        message?: unknown;
                        sequence?: unknown;
                    };
                    return (
                        input.message === PROBE_SEGMENTS &&
                        input.sequence === 1
                    );
                } catch {
                    return false;
                }
            })();

        return {
            label: config.label,
            model: config.model,
            durationMs: Date.now() - startedAt,
            ...(firstEventMs === undefined ? {} : {firstEventMs}),
            ...(firstToolDeltaMs === undefined ? {} : {firstToolDeltaMs}),
            sseEvents,
            toolDeltaEvents,
            argumentFragments,
            argumentCharacters,
            contentCharacters,
            reasoningCharacters,
            ...(finishReason ? {finishReason} : {}),
            doneReceived,
            toolCalls,
            argumentsAreValidJson,
            toolCallMatchesProbe,
            ...(usage ? {usage} : {}),
        };
    } finally {
        clearTimeout(timeout);
    }
}

function printResult(result: ProbeResult): void {
    console.log(`\n${result.label} 结果`);
    console.log(`- 模型: ${result.model}`);
    console.log(`- 总时长: ${(result.durationMs / 1_000).toFixed(3)}s`);
    console.log(`- 首个 SSE: ${result.firstEventMs ?? "未收到"}ms`);
    console.log(`- 首个工具增量: ${result.firstToolDeltaMs ?? "未收到"}ms`);
    console.log(`- SSE data events: ${result.sseEvents}`);
    console.log(`- tool delta events: ${result.toolDeltaEvents}`);
    console.log(
        `- arguments: ${result.argumentFragments} 个非空片段 / ${result.argumentCharacters} chars`
    );
    console.log(
        `- 其他输出: reasoning ${result.reasoningCharacters} chars / content ${result.contentCharacters} chars`
    );
    console.log(`- finish_reason: ${result.finishReason ?? "未收到"}`);
    console.log(`- [DONE]: ${result.doneReceived ? "收到" : "未收到"}`);
    console.log(`- 完整参数 JSON: ${result.argumentsAreValidJson ? "有效" : "Invalid"}`);
    console.log(`- 工具名与参数原文: ${result.toolCallMatchesProbe ? "一致" : "不一致"}`);
    if (result.usage) {
        console.log(`- usage: ${JSON.stringify(result.usage)}`);
    }

    if (result.toolCalls.length === 0) {
        console.log("- 判断: 未收到工具调用，Function Calling 未跑通。");
    } else if (!result.argumentsAreValidJson || !result.toolCallMatchesProbe) {
        console.log("- 判断: 收到了工具增量，但最终工具名或参数不完整、不正确。");
    } else if (result.argumentFragments >= 2) {
        console.log("- 判断: 工具参数分多个 SSE 增量到达，已证明参数流式输出。");
    } else {
        console.log(
            "- 判断: 工具调用成功，但参数只在一个增量中返回；本次样本不足以证明参数流式输出。"
        );
    }
}

function printComparison(results: readonly ProbeResult[]): void {
    if (results.length < 2) return;
    const [qwen, glm] = results;
    if (!qwen || !glm) return;
    console.log("\nQwen / GLM 对照");
    console.log(
        `- 首个工具增量: Qwen ${qwen.firstToolDeltaMs ?? "-"}ms / GLM ${glm.firstToolDeltaMs ?? "-"}ms`
    );
    console.log(
        `- 参数片段数: Qwen ${qwen.argumentFragments} / GLM ${glm.argumentFragments}`
    );
    console.log(
        `- 工具增量事件: Qwen ${qwen.toolDeltaEvents} / GLM ${glm.toolDeltaEvents}`
    );
    console.log(
        "- 请求协议: Qwen 仅使用 stream=true；GLM 额外使用 tool_stream=true。"
    );
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    loadEnv({required: false});
    const baseUrl = process.env.QWEN_BASE_URL || DEFAULT_BASE_URL;
    const configs: ProbeConfig[] = [];
    if (!options.glmOnly) {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
            throw new Error(
                "缺少 DASHSCOPE_API_KEY，请先在环境变量或 .env 中配置百炼 Key"
            );
        }
        configs.push({
            label: "Qwen",
            apiKey,
            baseUrl,
            model: process.env.QWEN_PROBE_MODEL || DEFAULT_QWEN_MODEL,
            requestFields: {enable_thinking: false},
        });
    }
    if (options.compareGlm || options.glmOnly) {
        const glmApiKey = process.env.GLM_API_KEY;
        if (!glmApiKey) {
            throw new Error(
                "GLM 诊断缺少 GLM_API_KEY"
            );
        }
        const model = process.env.GLM_COMPARE_MODEL || DEFAULT_GLM_MODEL;
        configs.push({
            label: "GLM",
            apiKey: glmApiKey,
            baseUrl: process.env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL,
            model,
            requestFields: createGlmRequestFields(),
        });
    }

    console.log("Tool stream diagnostic");
    console.log(`timeout: ${options.timeoutMs}ms`);
    console.log(
        `mode: ${options.compareGlm ? "Qwen + GLM comparison" : options.glmOnly ? "GLM only" : "Qwen only"}`
    );
    console.log("API Key 和完整工具参数不会输出。");

    const results: ProbeResult[] = [];
    for (const config of configs) {
        const result = await runProbe(config, options.timeoutMs);
        results.push(result);
        printResult(result);
    }
    printComparison(results);

    if (
        results.some(
            (result) =>
                result.toolCalls.length === 0 ||
                !result.argumentsAreValidJson ||
                !result.toolCallMatchesProbe
        )
    ) {
        process.exitCode = 2;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
});
