import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {AssistantDraftView} from "../../src/ui/conversation/AssistantDraftView.js";
import {ResponseDraft} from "../../src/agent/draft.js";

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 90));

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
