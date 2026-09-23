import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {AssistantDraftView} from "../../src/ui/conversation/AssistantDraftView.js";
import {ResponseDraft} from "../../src/agent/draft.js";
import {Box} from "ink";
import {ModelStreamStatus} from "../../src/ui/status/ModelStreamStatus.js";
import {DraftLayout, DraftLayoutProvider} from "../../src/ui/conversation/draftLayout.js";

const layoutDraft = (text: string, width: number) => new DraftLayout().read(text, width);
afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 90));

test("draft layout appends complete rows without emitting terminal control sequences", () => {
    const first = layoutDraft("first row\nsecond row\nlast", 30);
    const next = layoutDraft("first row\nsecond row\nlast continued\nnew tail", 30);
    expect(next.completed).toStartWith(first.completed);
    expect(next.tail).toBe("new tail");
    const unsafe = layoutDraft("start\x1b[2J\nnext\x07\ntail", 30);
    expect(unsafe.completed).not.toContain("\x1b");
    expect(unsafe.completed).not.toContain("\x07");
    expect(unsafe.completed).toContain("start");
});

test("a committed draft remains until final text, but settlement clears an abandoned handoff", () => {
    const store = new UITurnEventStore();
    store.handleEvent({type: "assistant_draft", responseId: "pending", text: "visible", truncated: false});
    store.handleEvent({type: "assistant_draft_end", responseId: "pending", disposition: "committed"});
    expect(store.getDraftSnapshot()?.text).toBe("visible");
    expect(store.getPersistedUIEvents()).toHaveLength(0);
    store.settleTurn();
    expect(store.getDraftSnapshot()).toBeNull();
    expect(store.getSnapshot().threads).toHaveLength(0);
});

test.each(["", "\n\n", "\r\n  \r\n", "\n".repeat(10)])("草稿尾部空白 %j 不扩大与工具状态的间距", (suffix) => {
    const store = new UITurnEventStore();
    const body = "现在写过滤测试和 App 集成测试。";
    const text = body + suffix;
    store.handleEvent({type: "assistant_draft", responseId: "spacing", text, truncated: false});
    const view = render(<Box flexDirection="column">
        <DraftLayoutProvider store={store}><AssistantDraftView phase="tool_input"/></DraftLayoutProvider>
        <ModelStreamStatus
            modelStream={{phase: "tool_input", toolName: "write_file", outputCharacters: 1120, estimatedOutputTokens: 280}}
            progressRef={{current: null}}
            stopping={false}
        />
    </Box>);
    const lines = (view.lastFrame() ?? "").split("\n");
    const bodyLine = lines.findIndex(line => line.includes(body));
    const statusLine = lines.findIndex(line => line.includes("Building write_file arguments"));
    expect(bodyLine).toBeGreaterThanOrEqual(0);
    expect(statusLine - bodyLine).toBe(2);
    expect(view.lastFrame()).not.toContain("Response commentary");
    expect(lines.find(line => line.trim())?.trim()).toBe(body);
    expect(view.lastFrame()).not.toContain("Generating");
    expect(lines[bodyLine + 1]?.trim()).toBe("");
    expect(store.getDraftSnapshot()?.text).toBe(text);
});

test("纯空白草稿不占位，正文内部空行和缩进仍保留", () => {
    const store = new UITurnEventStore();
    store.handleEvent({type: "assistant_draft", responseId: "blank", text: "\n \t\r\n", truncated: false});
    const blank = render(<DraftLayoutProvider store={store}><AssistantDraftView/></DraftLayoutProvider>);
    expect(blank.lastFrame()?.trim()).toBe("");
    blank.unmount();

    const text = "第一段\n\n    code();\n结束\n\n";
    store.handleEvent({type: "assistant_draft", responseId: "body", text, truncated: false});
    const body = render(<DraftLayoutProvider store={store}><AssistantDraftView/></DraftLayoutProvider>);
    expect(body.lastFrame()).toMatch(/第一段\n\s*\n {6}code\(\);\n {2}结束/);
    expect(store.getDraftSnapshot()?.text).toBe(text);
});

test("草稿有界更新独立区域，不改 Static；窄屏 resize 和撤销清理", async () => {
    const store = new UITurnEventStore({history: [{role: "assistant", content: "旧结论"}]});
    let rootUpdates = 0;
    store.subscribe(() => {rootUpdates++;});
    const staticBefore = store.getSnapshot().staticThreads;
    const view = render(<DraftLayoutProvider store={store}><AssistantDraftView/></DraftLayoutProvider>);
    let columns = 50;
    Object.defineProperties(view.stdout, {columns: {configurable: true, get: () => columns}, rows: {configurable: true, value: 18}});
    view.rerender(<DraftLayoutProvider store={store}><AssistantDraftView/></DraftLayoutProvider>);
    const draft = new ResponseDraft(store.handleEvent);
    await draft.update({type: "delta", text: "# 代码说明\n```ts\n" + "中".repeat(30_000) + "\n尾部正在生成"});
    await flush();
    expect(store.getDraftSnapshot()?.text.length).toBeLessThanOrEqual(200_000);
    expect(store.getDraftSnapshot()?.text).toStartWith("# 代码说明");
    expect(view.lastFrame()).toContain("# 代码说明");
    expect(view.lastFrame()).toContain("尾部正在生成");
    view.rerender(<DraftLayoutProvider store={store}><AssistantDraftView phase="tool_input"/></DraftLayoutProvider>);
    expect(view.lastFrame()).not.toContain("showing recent text");
    expect(view.lastFrame()).not.toContain("Response commentary");
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


test("进入工具参数阶段补齐正文尾部，回到正文阶段再显示生成状态", async () => {
    const store = new UITurnEventStore();
    const draft = new ResponseDraft(store.handleEvent);
    const view = render(<DraftLayoutProvider store={store}><AssistantDraftView phase="content"/></DraftLayoutProvider>);
    try {
        await draft.update({type: "delta", text: "我已经了解全貌，现在"});
        await draft.update({type: "delta", text: "写一份说明文档。"});
        view.rerender(<DraftLayoutProvider store={store}><AssistantDraftView phase="tool_input"/></DraftLayoutProvider>);
        await flush();
        expect(view.lastFrame()).toContain("我已经了解全貌，现在写一份说明文档。");
        expect(view.lastFrame()).not.toContain("Response commentary");
        expect(view.lastFrame()).not.toContain("Generating");
        view.rerender(<DraftLayoutProvider store={store}><AssistantDraftView phase="content"/></DraftLayoutProvider>);
        expect(view.lastFrame()).toContain("Generating");
    } finally {await draft.finish("discarded");}
});


test("incremental layout preserves Unicode boundaries, trailing whitespace, replacement and resize", () => {
    const layout = new DraftLayout();
    const text = "中文 👩‍👩‍👧‍👦 🇨🇳 e\u0301\t x\n".repeat(40);
    for (let end = 1; end <= text.length; end += 3) {
        const part = text.slice(0, end);
        expect(layout.read(part, 19)).toEqual(layoutDraft(part, 19));
    }
    expect(layout.read(text, 9)).toEqual(layoutDraft(text, 9));
    expect(layout.read("replacement\nlast", 9)).toEqual(layoutDraft("replacement\nlast", 9));
});
