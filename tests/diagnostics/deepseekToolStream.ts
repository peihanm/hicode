import {loadEnv} from "../../src/cli/env.js";
import {createGlmRequestFields} from "../../src/llm/providers/glm.js";

interface ProbeOptions {
    compareGlm: boolean;
    thinking: boolean;
    timeoutMs: number;
}

interface ProbeConfig {
    label: "DeepSeek" | "GLM";
    apiKey: string;
    baseUrl: string;
    model: string;
    requestFields: Record<string, unknown>;
    toolChoice?: "required";
}

interface ToolCallDelta {
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
            tool_calls?: ToolCallDelta[] | null;
        };
        message?: {
            tool_calls?: ToolCallDelta[] | null;
        };
        finish_reason?: string | null;
    }>;
    usage?: Record<string, unknown> | null;
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
    lastToolDeltaMs?: number;
    sseEvents: number;
    toolDeltaEvents: number;
    argumentFragments: number;
    argumentCharacters: number;
    bufferedMessageToolCalls: number;
    contentCharacters: number;
    reasoningCharacters: number;
    finishReason?: string;
    doneReceived: boolean;
    toolCalls: ToolCallAccumulator[];
    argumentsAreValidJson: boolean;
    toolCallMatchesProbe: boolean;
    usage?: Record<string, unknown>;
}

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_JENIYA_BASE_URL = "https://jeniya.cn/v1";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEFAULT_GLM_MODEL = "glm-5.2";
const DEFAULT_TIMEOUT_MS = 120_000;

const TOOL_NAME = "record_stream_probe";
const PROBE_MESSAGE = Array.from(
    {length: 32},
    (_, index) =>
        `segment-${String(index + 1).padStart(2, "0")}-abcdefghijklmnopqrstuvwx`
).join("|");

const TOOLS = [
    {
        type: "function",
        function: {
            name: TOOL_NAME,
            description: "记录工具参数流式传输诊断数据。必须原样保存用户给出的字段。",
            parameters: {
                type: "object",
                properties: {
                    message: {
                        type: "string",
                        description: "原样保存用户给出的诊断字符串。",
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
    "用法：",
    "  bun tests/diagnostics/deepseekToolStream.ts",
    "  bun tests/diagnostics/deepseekToolStream.ts --thinking",
    "  bun tests/diagnostics/deepseekToolStream.ts --compare-glm",
    "  bun tests/diagnostics/deepseekToolStream.ts --thinking --compare-glm",
    "  bun tests/diagnostics/deepseekToolStream.ts --timeout-ms 180000",
    "",
    "环境变量：",
    "  DEEPSEEK_API_KEY      必填；DeepSeek 官方 API Key",
    `  DEEPSEEK_BASE_URL     可选；默认 ${DEFAULT_DEEPSEEK_BASE_URL}`,
    `  DEEPSEEK_PROBE_MODEL  可选；默认 ${DEFAULT_DEEPSEEK_MODEL}`,
    "  JENIYA_API_KEY        --compare-glm 时必填",
    `  JENIYA_BASE_URL       可选；默认 ${DEFAULT_JENIYA_BASE_URL}`,
    `  GLM_COMPARE_MODEL     可选；默认 ${DEFAULT_GLM_MODEL}`,
    "",
    "默认关闭 DeepSeek 思考模式，以最小成本隔离工具流行为；--thinking 会开启思考模式。",
    "脚本不会打印 API Key 或完整工具参数。",
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
    let thinking = false;
    let timeoutMs = DEFAULT_TIMEOUT_MS;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--compare-glm") {
            compareGlm = true;
            continue;
        }
        if (argument === "--thinking") {
            thinking = true;
            continue;
        }
        if (argument === "--timeout-ms") {
            timeoutMs = parsePositiveInteger(argv[index + 1], "--timeout-ms");
            index += 1;
            continue;
        }
        if (argument === "--help" || argument === "-h") {
            console.log(USAGE);
            process.exit(0);
        }
        throw new Error(`未知参数: ${argument ?? "<empty>"}`);
    }
    return {compareGlm, thinking, timeoutMs};
}

function completionsUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith("/chat/completions")
        ? normalized
        : `${normalized}/chat/completions`;
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
                    buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
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

function appendFragment(current: string, fragment: string): string {
    if (!fragment) return current;
    if (!current) return fragment;
    if (fragment === current || current.endsWith(fragment)) return current;
    if (fragment.startsWith(current)) return fragment;
    return current + fragment;
}

function preview(value: string): string {
    const compact = value.replace(/\s+/g, " ");
    return JSON.stringify(
        compact.length > 48 ? `${compact.slice(0, 48)}…` : compact
    );
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
                role: "user",
                content: `请调用 ${TOOL_NAME}，sequence 填 1，message 原样填写以下字符串：${PROBE_MESSAGE}`,
            },
        ],
        tools: TOOLS,
        ...(config.toolChoice ? {tool_choice: config.toolChoice} : {}),
        stream: true,
        stream_options: {include_usage: true},
        max_tokens: 2_048,
    };
}

function applyToolCall(
    target: Map<number, ToolCallAccumulator>,
    call: ToolCallDelta
): string {
    const index = call.index ?? 0;
    const current = target.get(index) ?? {id: "", name: "", arguments: ""};
    if (call.id) current.id = call.id;
    current.name = appendFragment(current.name, call.function?.name ?? "");
    const argumentFragment = call.function?.arguments ?? "";
    current.arguments += argumentFragment;
    target.set(index, current);
    return argumentFragment;
}

async function runProbe(
    config: ProbeConfig,
    timeoutMs: number
): Promise<ProbeResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new Error(`${config.label} 请求超过 ${timeoutMs}ms`)),
        timeoutMs
    );
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

        console.log(
            `[${config.label}] content-type=${response.headers.get("content-type") ?? "unknown"}`
        );

        const deltaTools = new Map<number, ToolCallAccumulator>();
        const bufferedTools = new Map<number, ToolCallAccumulator>();
        let firstEventMs: number | undefined;
        let firstToolDeltaMs: number | undefined;
        let lastToolDeltaMs: number | undefined;
        let sseEvents = 0;
        let toolDeltaEvents = 0;
        let argumentFragments = 0;
        let argumentCharacters = 0;
        let bufferedMessageToolCalls = 0;
        let contentCharacters = 0;
        let reasoningCharacters = 0;
        let finishReason: string | undefined;
        let doneReceived = false;
        let usage: Record<string, unknown> | undefined;

        for await (const data of readSseData(response.body)) {
            sseEvents += 1;
            firstEventMs ??= Date.now() - startedAt;
            if (data === "[DONE]") {
                doneReceived = true;
                continue;
            }

            let chunk: StreamChunk;
            try {
                chunk = JSON.parse(data) as StreamChunk;
            } catch (error) {
                throw new Error(
                    `${config.label} 返回无效 SSE JSON: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            contentCharacters += choice.delta?.content?.length ?? 0;
            reasoningCharacters += choice.delta?.reasoning_content?.length ?? 0;

            for (const call of choice.delta?.tool_calls ?? []) {
                const elapsedMs = Date.now() - startedAt;
                firstToolDeltaMs ??= elapsedMs;
                lastToolDeltaMs = elapsedMs;
                toolDeltaEvents += 1;
                const fragment = applyToolCall(deltaTools, call);
                if (fragment) {
                    argumentFragments += 1;
                    argumentCharacters += fragment.length;
                }
                if (toolDeltaEvents <= 12 || toolDeltaEvents % 50 === 0) {
                    console.log(
                        `[${config.label} ${(elapsedMs / 1_000).toFixed(3)}s]` +
                            ` tool[${call.index ?? 0}] delta=${toolDeltaEvents}` +
                            ` args+=${fragment.length}` +
                            `${fragment ? ` ${preview(fragment)}` : ""}`
                    );
                }
            }

            for (const call of choice.message?.tool_calls ?? []) {
                bufferedMessageToolCalls += 1;
                applyToolCall(bufferedTools, call);
            }
        }

        const selectedTools = deltaTools.size > 0 ? deltaTools : bufferedTools;
        const toolCalls = [...selectedTools.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, call]) => call);
        const argumentsAreValidJson =
            toolCalls.length > 0 &&
            toolCalls.every((call) => {
                try {
                    JSON.parse(call.arguments);
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
                    return input.message === PROBE_MESSAGE && input.sequence === 1;
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
            ...(lastToolDeltaMs === undefined ? {} : {lastToolDeltaMs}),
            sseEvents,
            toolDeltaEvents,
            argumentFragments,
            argumentCharacters,
            bufferedMessageToolCalls,
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
    console.log(
        `- 工具增量持续: ${
            result.firstToolDeltaMs === undefined || result.lastToolDeltaMs === undefined
                ? "未收到"
                : `${result.lastToolDeltaMs - result.firstToolDeltaMs}ms`
        }`
    );
    console.log(`- SSE data events: ${result.sseEvents}`);
    console.log(`- tool delta events: ${result.toolDeltaEvents}`);
    console.log(
        `- arguments: ${result.argumentFragments} 个非空片段 / ${result.argumentCharacters} chars`
    );
    console.log(`- message.tool_calls: ${result.bufferedMessageToolCalls}`);
    console.log(
        `- 其他输出: reasoning ${result.reasoningCharacters} chars / content ${result.contentCharacters} chars`
    );
    console.log(`- finish_reason: ${result.finishReason ?? "未收到"}`);
    console.log(`- [DONE]: ${result.doneReceived ? "收到" : "未收到"}`);
    console.log(`- 完整参数 JSON: ${result.argumentsAreValidJson ? "有效" : "无效"}`);
    console.log(`- 工具名与参数原文: ${result.toolCallMatchesProbe ? "一致" : "不一致"}`);
    if (result.usage) console.log(`- usage: ${JSON.stringify(result.usage)}`);

    if (result.toolCalls.length === 0) {
        console.log("- 判断: 未收到工具调用，Function Calling 未跑通。");
    } else if (!result.argumentsAreValidJson || !result.toolCallMatchesProbe) {
        console.log("- 判断: 收到工具调用，但最终工具名或参数不完整、不正确。");
    } else if (result.argumentFragments >= 2) {
        console.log("- 判断: arguments 分多个 SSE delta 到达，已证明工具参数流式输出。");
    } else if (result.argumentFragments === 1) {
        console.log(
            "- 判断: 工具调用成功，但 arguments 在单个 SSE delta 中一次返回；本次没有观察到参数流式分片。"
        );
    } else {
        console.log(
            "- 判断: 工具调用只出现在 message.tool_calls，属于缓冲结果，没有观察到参数流式分片。"
        );
    }
}

function printComparison(results: readonly ProbeResult[]): void {
    const deepseek = results.find((result) => result.label === "DeepSeek");
    const glm = results.find((result) => result.label === "GLM");
    if (!deepseek || !glm) return;

    console.log("\nDeepSeek / GLM 对照");
    console.log(
        `- 首个工具增量: DeepSeek ${deepseek.firstToolDeltaMs ?? "-"}ms / GLM ${glm.firstToolDeltaMs ?? "-"}ms`
    );
    console.log(
        `- 参数片段数: DeepSeek ${deepseek.argumentFragments} / GLM ${glm.argumentFragments}`
    );
    console.log(
        `- 工具增量事件: DeepSeek ${deepseek.toolDeltaEvents} / GLM ${glm.toolDeltaEvents}`
    );
    console.log(
        "- 请求协议: DeepSeek 使用标准 stream=true；GLM 额外使用 Pillar 当前的 tool_stream=true 扩展。"
    );
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    loadEnv({required: false});

    const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
    if (!deepseekApiKey) {
        throw new Error("缺少 DEEPSEEK_API_KEY，请先在 .env 中填写 DeepSeek API Key");
    }

    const configs: ProbeConfig[] = [
        {
            label: "DeepSeek",
            apiKey: deepseekApiKey,
            baseUrl: process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
            model: process.env.DEEPSEEK_PROBE_MODEL || DEFAULT_DEEPSEEK_MODEL,
            requestFields: {
                thinking: {type: options.thinking ? "enabled" : "disabled"},
                ...(options.thinking ? {reasoning_effort: "high"} : {}),
            },
            ...(options.thinking ? {} : {toolChoice: "required" as const}),
        },
    ];

    if (options.compareGlm) {
        const glmApiKey = process.env.JENIYA_API_KEY;
        if (!glmApiKey) {
            throw new Error("--compare-glm 需要在 .env 中填写 JENIYA_API_KEY");
        }
        const glmModel = process.env.GLM_COMPARE_MODEL || DEFAULT_GLM_MODEL;
        configs.push({
            label: "GLM",
            apiKey: glmApiKey,
            baseUrl: process.env.JENIYA_BASE_URL || DEFAULT_JENIYA_BASE_URL,
            model: glmModel,
            requestFields: createGlmRequestFields(glmModel),
        });
    }

    console.log("DeepSeek tool stream diagnostic");
    console.log(`timeout: ${options.timeoutMs}ms`);
    console.log(`DeepSeek thinking: ${options.thinking ? "enabled" : "disabled"}`);
    console.log(`GLM comparison: ${options.compareGlm ? "enabled" : "disabled"}`);
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
