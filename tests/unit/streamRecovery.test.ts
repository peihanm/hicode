import {afterEach, expect, test} from "bun:test";
import {readFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {createOpenAICompatibleCaller} from "../../src/llm/providers/openAICompatible.js";
import {consumeOpenAICompatibleSSE, OpenAICompatibleProtocolError} from "../../src/llm/providers/openAICompatibleStream.js";
import {getProjectDebugDirectory} from "../../src/persistence/index.js";
import type {LLMCallOptions, LLMCaller, LLMStreamProgress, LLMTextUpdate, Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {runAgentForTest} from "../helpers/agent.js";
import {createTestContext} from "../helpers/testContext.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {hasCompleteToolPairs} from "../../src/session/codec.js";

const originalFetch = globalThis.fetch;
function mockFetch(handler: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = Object.assign(handler, {preconnect() {}});
}
afterEach(() => {globalThis.fetch = originalFetch;});
const endpoint = {displayName: "offline", baseUrl: "https://fixture.invalid", apiKey: "fixture-secret"};
const usage = {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12};
function event(delta: unknown, finish_reason: string | null = null): string {
    return `data: ${JSON.stringify({choices: [{delta, finish_reason}], usage})}\n\n`;
}
function response(payload: string): Response {
    return new Response(payload + "data: [DONE]\n\n");
}
function disconnectedResponse(payload: string): Response {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent) controller.error(new TypeError("private connection details"));
            else {
                sent = true;
                controller.enqueue(new TextEncoder().encode(payload));
            }
        },
    }));
}
const malformed = event({content: "discard this draft", tool_calls: [{index: 0, function: {arguments: "sensitive arguments"}}]}, "tool_calls");
const good = event({content: "recovered"}, "stop");
const caller = createOpenAICompatibleCaller({retryBaseDelayMs: 0});
function options(cwd: string, storage: LLMCallOptions["storage"]): LLMCallOptions {
    return {cwd, storage, kind: "main", model: "offline", messages: [{role: "user", origin: "user" as const, content: "continue"}], tools: []};
}

test("残缺工具响应只重试模型请求，重置草稿并累加已报告 usage", async () => withTempProject(async (cwd, storage) => {
    const bodies: string[] = [];
    mockFetch(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return response(bodies.length === 1 ? malformed : good);
    });
    const updates: LLMTextUpdate[] = [];
    const phases: string[] = [];
    const result = await caller({...options(cwd, storage), onText(update) {updates.push(update);},
        onStreamProgress(progress) {phases.push(progress.phase);}}, endpoint);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(result.message.content).toBe("recovered");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage.total_tokens).toBe(24);
    expect(result.contextUsage?.tokenCount).toBe(12);
    expect(updates).toEqual([{type: "reset"}, {type: "delta", text: "discard this draft"}, {type: "reset"}, {type: "delta", text: "recovered"}]);
    expect(phases.filter(phase => phase === "retrying")).toHaveLength(1);
    const directory = join(getProjectDebugDirectory(storage, cwd), "prompt-logs");
    const logs = await Promise.all((await readdir(directory)).map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
    const failed = logs.find(log => log.response.error);
    expect(failed.response.rawResponse.protocolFailure).toMatchObject({code: "missing_tool_identity", finishReason: "tool_calls", done: true,
        tools: [{index: 0, hasId: false, hasName: false, argumentCharacters: 19}]});
    expect(JSON.stringify(failed.response)).not.toContain("sensitive arguments");
    expect(JSON.stringify(failed.response)).not.toContain("discard this draft");
}));

test("重复协议失败最多两次；不能无限重试", async () => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => {count++; return response(malformed);});
    await expect(caller(options(cwd, storage), endpoint)).rejects.toThrow("retry budget exhausted");
    expect(count).toBe(2);
}));

test("协议恢复与 HTTP 重试共享三次总预算", async () => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => ++count === 1 ? new Response("busy", {status: 503}) : response(malformed));
    await expect(caller(options(cwd, storage), endpoint)).rejects.toThrow("retry budget exhausted");
    expect(count).toBe(3);
}));

test("协议恢复退避响应取消，不发起下一次请求", async () => withTempProject(async (cwd, storage) => {
    let count = 0;
    const controller = new AbortController();
    mockFetch(async () => {count++; return response(malformed);});
    await expect(caller({...options(cwd, storage), signal: controller.signal, onStreamProgress(progress) {
        if (progress.phase === "retrying") controller.abort("user-cancel");
    }}, endpoint)).rejects.toThrow();
    expect(count).toBe(1);
}));

test.each(["length", "content_filter"])("%s 完成原因不当作临时协议错误重试", async reason => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => {count++; return response(event({content: "partial"}, reason));});
    await expect(caller(options(cwd, storage), endpoint)).rejects.toThrow(reason);
    expect(count).toBe(1);
}));

test("失败结构摘要只保留最后 16 个工具分片且不包含原始字段值", async () => {
    const payload = Array.from({length: 24}, () => event({tool_calls: [{index: 2, function: {arguments: "private-data"}}]})).join("") + event({}, "tool_calls");
    try {
        await consumeOpenAICompatibleSSE({body: response(payload).body!, signal: new AbortController().signal, onActivity() {}});
        throw new Error("expected rejection");
    } catch (error) {
        expect(error).toBeInstanceOf(OpenAICompatibleProtocolError);
        if (!(error instanceof OpenAICompatibleProtocolError)) throw error;
        expect(error.diagnostic.recentToolFragments).toHaveLength(16);
        expect(error.diagnostic.recentToolFragments[0]?.event).toBe(9);
        expect(error.diagnostic.tools).toEqual([{index: 2, hasId: false, hasName: false, argumentCharacters: 288}]);
        expect(JSON.stringify(error.diagnostic)).not.toContain("private-data");
    }
});

test.each([
    ["完成信号缺失", event({content: "truncated"})],
    ["完成原因不一致", event({}, "tool_calls")],
    ["重复工具 ID", event({tool_calls: [0, 1].map(index => ({index, id: "duplicate", function: {name: "read_file", arguments: "{}"}}))}, "tool_calls")],
])("%s 可以有限恢复", async (_label, payload) => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => response(++count === 1 ? payload : good));
    expect((await caller(options(cwd, storage), endpoint)).message.content).toBe("recovered");
    expect(count).toBe(2);
}));

test.each([
    ["stream_disconnected", () => disconnectedResponse(event({content: "partial"}))],
    ["empty_stream", () => response("")],
    ["empty_stream", () => new Response(null)],
    ["invalid_json", () => response('data: {"secret": "private-output"\n\n')],
] as const)("%s 接收失败自动恢复且不泄漏原始输出", async (reason, broken) => withTempProject(async (cwd, storage) => {
    let count = 0;
    const progress: LLMStreamProgress[] = [];
    mockFetch(async () => ++count === 1 ? broken() : response(good));
    const result = await caller({...options(cwd, storage), onStreamProgress(item) {progress.push(item);}}, endpoint);
    expect(result.message.content).toBe("recovered");
    expect(count).toBe(2);
    expect(result.usage.total_tokens).toBe(reason === "stream_disconnected" ? 24 : 12);
    expect(progress.filter(item => item.phase === "retrying")).toEqual([{
        phase: "retrying", outputCharacters: 0, estimatedOutputTokens: 0,
        retry: {reason, attempt: 2, maxAttempts: 3},
    }]);
    const directory = join(getProjectDebugDirectory(storage, cwd), "prompt-logs");
    const logs = await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), "utf8")));
    expect(logs.join("")).not.toContain("private-output");
    expect(logs.join("")).not.toContain("private connection details");
}));

test("不同流故障共享一次恢复额度，不按故障种类叠加", async () => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => ++count === 1 ? disconnectedResponse("") : response(malformed));
    await expect(caller(options(cwd, storage), endpoint)).rejects.toThrow("tools from this response were not executed; retry budget exhausted");
    expect(count).toBe(2);
}));

test("网络、HTTP 和流恢复共用总预算，并统一报告次数", async () => withTempProject(async (cwd, storage) => {
    let count = 0;
    const progress: LLMStreamProgress[] = [];
    mockFetch(async () => {
        count++;
        if (count === 1) throw new TypeError("connection reset");
        return count === 2 ? new Response("busy", {status: 503}) : disconnectedResponse("");
    });
    await expect(caller({...options(cwd, storage), onStreamProgress(item) {progress.push(item);}}, endpoint)).rejects.toThrow("attempted 3/3 times");
    expect(count).toBe(3);
    expect(progress.map(item => item.retry)).toEqual([
        {reason: "connection", attempt: 2, maxAttempts: 3},
        {reason: "http", attempt: 3, maxAttempts: 3},
    ]);
}));

test.each([
    ["非法字段类型", () => response(event({content: 123}, "stop"))],
    ["事件超限", () => response("data: " + "x".repeat(8 * 1024 * 1024))],
] as const)("%s 不能触发自动恢复", async (_label, broken) => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => {count++; return broken();});
    await expect(caller(options(cwd, storage), endpoint)).rejects.toThrow();
    expect(count).toBe(1);
}));

test.each(["json", "callback", "cancel"] as const)("%s 退出时关闭底层流；取消和回调异常不重试", async mode => withTempProject(async (cwd, storage) => {
    let count = 0;
    let closed = false;
    const abort = new AbortController();
    mockFetch(async () => {
        count++;
        if (count > 1) {
            expect(closed).toBe(true);
            return response(good);
        }
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {controller.enqueue(new TextEncoder().encode(
                mode === "json" ? 'data: {"truncated":\n\n' : event({content: "draft"})
            ));},
            cancel() {closed = true;},
        }));
    });
    const promise = caller({...options(cwd, storage), signal: abort.signal,
        onText(update) {
            if (update.type !== "delta") return;
            if (mode === "callback") throw new Error("host callback failed");
            if (mode === "cancel") abort.abort("user-cancel");
        }}, endpoint);
    if (mode === "json") expect((await promise).message.content).toBe("recovered");
    else await expect(promise).rejects.toThrow();
    expect(count).toBe(mode === "json" ? 2 : 1);
    expect(closed).toBe(true);
}));

test("重试进度回调抛错时直接退出，不再请求", async () => withTempProject(async (cwd, storage) => {
    let count = 0;
    mockFetch(async () => {count++; return new Response("busy", {status: 503});});
    await expect(caller({...options(cwd, storage), onStreamProgress() {throw new Error("host progress failed");}}, endpoint)).rejects.toThrow("host progress failed");
    expect(count).toBe(1);
}));

test.each(["identity", "disconnect", "json"] as const)("真实 Agent %s 恢复：既有写入不重放，坏批次零执行且 History 配对完整", async failure => withTempProject(async (cwd) => {
    const write = (id: string, path: string) => ({index: 0, id, function: {name: "write_file", arguments: JSON.stringify({path, content: id})}});
    const responses = [
        event({tool_calls: [write("first-write", "first.txt")]}, "tool_calls"),
        event({content: "uncommitted draft", tool_calls: failure === "identity"
            ? [write("ghost-write", "ghost.txt"), {index: 1}]
            : [write("ghost-write", "ghost.txt")]}, failure === "disconnect" ? null : "tool_calls"),
        event({tool_calls: [write("second-write", "second.txt")]}, "tool_calls"),
        good,
    ];
    let count = 0;
    mockFetch(async () => {
        const payload = responses[count++];
        if (!payload) throw new Error("unexpected request");
        if (count === 2 && failure === "disconnect") return disconnectedResponse(payload);
        if (count === 2 && failure === "json") return response(payload + 'data: {"broken":\n\n');
        return response(payload);
    });
    const callLLM: LLMCaller = (messages, tools, storage, cwd, model, kind, signal, onStreamProgress, onText) =>
        caller({messages, tools, storage, cwd, model, kind, signal, onStreamProgress, onText}, endpoint);
    const history: Message[] = [{role: "system", content: "offline test"}];
    const events: AgentEvent[] = [];
    const result = await runAgentForTest("write two files", history, item => {events.push(item);}, createTestContext(cwd), {callLLM});
    expect(result.reason).toBe("completed");
    expect(count).toBe(4);
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("first-write");
    expect(await readFile(join(cwd, "second.txt"), "utf8")).toBe("second-write");
    expect(await readdir(cwd)).not.toContain("ghost.txt");
    expect(events.filter(item => item.type === "tool_call_start").map(item => item.toolCallId)).toEqual(["first-write", "second-write"]);
    expect(events.some(item => item.type === "assistant_draft_end" && item.disposition === "discarded")).toBe(true);
    expect(JSON.stringify(history)).not.toContain("ghost-write");
    expect(JSON.stringify(history)).not.toContain("uncommitted draft");
    expect(hasCompleteToolPairs(history)).toBe(true);
}));
