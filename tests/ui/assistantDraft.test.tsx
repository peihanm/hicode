import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {AssistantDraftView} from "../../src/ui/conversation/AssistantDraftView.js";
import {ResponseDraft} from "../../src/agent/draft.js";
import {Box} from "ink";
import {ModelStreamStatus} from "../../src/ui/status/ModelStreamStatus.js";

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 90));

test.each(["", "\n\n", "\r\n  \r\n", "\n".repeat(10)])("草稿尾部空白 %j 不扩大与工具状态的间距", (suffix) => {
    const store = new UITurnEventStore();
    const body = "现在写过滤测试和 App 集成测试。";
    const text = body + suffix;
    store.handleEvent({type: "assistant_draft", responseId: "spacing", text, truncated: false});
    const view = render(<Box flexDirection="column">
        <AssistantDraftView store={store}/>
        <ModelStreamStatus
            modelStream={{phase: "tool_input", toolName: "write_file", outputCharacters: 1120, estimatedOutputTokens: 280}}
            progressRef={{current: null}}
            stopping={false}
        />
    </Box>);
    const lines = (view.lastFrame() ?? "").split("\n");
    const bodyLine = lines.findIndex(line => line.includes(body));
    const statusLine = lines.findIndex(line => line.includes("正在构造 write_file 参数"));
    expect(bodyLine).toBeGreaterThanOrEqual(0);
    expect(statusLine - bodyLine).toBe(2);
    expect(lines[bodyLine + 1]?.trim()).toBe("");
    expect(store.getDraftSnapshot()?.text).toBe(text);
});

test("纯空白草稿不占位，正文内部空行和缩进仍保留", () => {
    const store = new UITurnEventStore();
    store.handleEvent({type: "assistant_draft", responseId: "blank", text: "\n \t\r\n", truncated: false});
    const blank = render(<AssistantDraftView store={store}/>);
    expect(blank.lastFrame()?.trim()).toBe("");
    blank.unmount();

    const text = "第一段\n\n    code();\n结束\n\n";
    store.handleEvent({type: "assistant_draft", responseId: "body", text, truncated: false});
    const body = render(<AssistantDraftView store={store}/>);
    expect(body.lastFrame()).toMatch(/第一段\n\s*\n {6}code\(\);\n {2}结束/);
    expect(store.getDraftSnapshot()?.text).toBe(text);
});

test("草稿有界更新独立区域，不改 Static；窄屏 resize 和撤销清理", async () => {
    const store = new UITurnEventStore({history: [{role: "assistant", content: "旧结论"}]});
    let rootUpdates = 0;
    store.subscribe(() => {rootUpdates++;});
    const staticBefore = store.getSnapshot().staticThreads;
    const view = render(<AssistantDraftView store={store}/>);
    let columns = 50;
    Object.defineProperties(view.stdout, {columns: {configurable: true, get: () => columns}, rows: {configurable: true, value: 18}});
    view.rerender(<AssistantDraftView store={store}/>);
    const draft = new ResponseDraft(store.handleEvent);
    await draft.update({type: "delta", text: "# 代码说明\n```ts\n" + "中".repeat(30_000) + "\n尾部正在生成"});
    await flush();
    expect(store.getDraftSnapshot()?.text.length).toBeLessThanOrEqual(8_000);
    expect(view.lastFrame()).toContain("尾部正在生成");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(8);
    expect(rootUpdates).toBe(0);
    expect(store.getSnapshot().staticThreads).toBe(staticBefore);
    columns = 28;
    view.stdout.emit("resize");
    await flush();
    expect(view.lastFrame()).toContain("尾部正在生成");
    await draft.finish("discarded");
    await flush();
    expect(view.lastFrame()).not.toContain("尾部正在生成");
    expect(store.getSnapshot().staticThreads).toBe(staticBefore);
    store.handleEvent({type: "assistant_text", content: "完整正式正文", phase: "final"});
    expect(store.getSnapshot().threads.filter(thread => JSON.stringify(thread).includes("完整正式正文"))).toHaveLength(1);
});

test("恢复 Session 清掉临时正文，晚到的旧响应终止不清新草稿", () => {
    const store = new UITurnEventStore();
    store.handleEvent({type: "assistant_draft", responseId: "new", text: "new", truncated: false});
    store.handleEvent({type: "assistant_draft_end", responseId: "old", disposition: "discarded"});
    expect(store.getDraftSnapshot()?.responseId).toBe("new");
    store.restore({history: [], uiEvents: []});
    expect(store.getDraftSnapshot()).toBeNull();
});
