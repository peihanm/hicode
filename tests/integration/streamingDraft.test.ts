import {expect, test} from "bun:test";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {AgentEvent} from "../../src/agent/types.js";
import type {Message} from "../../src/llm/types.js";
import {consumeOpenAICompatibleSSE} from "../../src/llm/providers/openAICompatibleStream.js";
import type {Todo} from "../../src/todos.js";

test("SSE 正文在完成前可见，推理和残缺工具参数不会成为正文", async () => {
    const encoder = new TextEncoder();
    let enqueue: (value: string) => void = () => {};
    let close = () => {};
    const text: string[] = [];
    let observed!: () => void;
    const firstText = new Promise<void>(resolve => {observed = resolve;});
    const body = new ReadableStream<Uint8Array>({start(controller) {
        enqueue = value => controller.enqueue(encoder.encode(value));
        close = () => controller.close();
    }});
    const running = consumeOpenAICompatibleSSE({body, signal: new AbortController().signal, onActivity: () => {},
        onText: value => {text.push(value); observed();}});
    enqueue('data: {"choices":[{"delta":{"reasoning_content":"private","content":"正在回答"}}]}\n\n');
    await firstText;
    expect(text).toEqual(["正在回答"]);
    close();
    await expect(running).rejects.toThrow();
});

test.each(["complete", "retry", "failure", "cancel", "revision"])("正文草稿的身份与结束语义 %s", async mode => {
    await withTempProject(async cwd => {
        const events: AgentEvent[] = [];
        const history: Message[] = [];
        const controller = new AbortController();
        let calls = 0;
        let todos: Todo[] = [];
        const running = runAgentForTest("回答", history, event => {events.push(event);}, createTestContext(cwd, {
            signal: controller.signal, setTodos: next => {todos = next;},
        }), {
            getTodos: () => todos,
            callLLM: async (_messages, _tools, _storage, _cwd, _model, _kind, _signal, _progress, onText) => {
                calls++;
                if (mode === "revision" && (calls === 1 || calls === 3)) return assistantToolCall("todo_write", {
                    todos: [{content: "完成任务", activeForm: "正在完成任务", status: calls === 1 ? "in_progress" : "completed"}],
                }, `todo-${calls}`);
                await onText?.({type: "reset"});
                await onText?.({type: "delta", text: "正在生成"});
                expect(events.at(-1)?.type).toBe("assistant_draft");
                expect(history.some(message => message.content === "正在生成")).toBe(false);
                if (mode === "failure") throw new Error("truncated response");
                if (mode === "cancel") controller.abort("user-cancel");
                if (mode === "retry") {
                    await onText?.({type: "reset"});
                    await onText?.({type: "delta", text: "新的回复"});
                }
                return assistantText(mode === "revision" && calls === 2 ? "任务已完成" : "最终结论");
            },
        });
        if (mode === "failure") await expect(running).rejects.toThrow("truncated");
        else await running;
        const drafts = events.filter(event => event.type === "assistant_draft");
        const ends = events.filter(event => event.type === "assistant_draft_end");
        expect(ends).toHaveLength(drafts.length);
        expect(new Set(drafts.map(event => event.responseId)).size).toBe(drafts.length);
        const final = events.filter(event => event.type === "assistant_text");
        if (mode === "failure" || mode === "cancel") {
            expect(ends.every(event => event.disposition === "discarded")).toBe(true);
            expect(final).toHaveLength(0);
        } else {
            expect(ends.at(-1)?.disposition).toBe("committed");
            expect(final.at(-1)?.responseId).toBe(ends.at(-1)?.responseId);
            expect(final).toHaveLength(1);
            if (mode === "retry" || mode === "revision") expect(ends[0]?.disposition).toBe("discarded");
        }
    });
});
