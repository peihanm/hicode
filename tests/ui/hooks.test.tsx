import {expect, test} from "bun:test";
import {render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {SDKEventAdapter} from "../../src/sdk/eventAdapter.js";
import type {ThreadEventPayload} from "../../src/sdk/protocol.js";
import type {HookLifecycleEvent} from "../../src/hooks/types.js";

const started: Extract<HookLifecycleEvent, {type: "hook_started"}> = {type: "hook_started", execution: {
    hookId: "a".repeat(64), dispatchId: "dispatch", executionId: "execution", startedAt: "2026-09-07T00:00:00Z",
    purpose: "observe", event: "PostToolBatch", source: "host", type: "command", handler: "check.sh",
}};
const completed: HookLifecycleEvent = {type: "hook_completed", execution: {...started.execution,
    outcome: "success", durationMs: 12, userMessage: "检查完成"}};

test("运行中 Hook 留在 live 区，完成后同一条记录进入 Static，resize 渲染不复制", () => {
    const store = new UITurnEventStore();
    store.handleEvent(started);
    store.settleTurn();
    expect(store.getSnapshot().staticThreads).toHaveLength(0);
    expect(store.getSnapshot().threads[0]).toMatchObject({role: "hook", status: "running"});
    const screen = render(<MessageList threads={store.getSnapshot().threads} terminalWidth={50}/>);
    expect(screen.lastFrame()).toContain("Hook PostToolBatch");
    expect(screen.lastFrame()).toContain("check.sh");
    store.handleEvent(completed);
    store.settleTurn();
    expect(store.getSnapshot().staticThreads).toHaveLength(1);
    expect(store.getSnapshot().staticThreads[0]).toMatchObject({role: "hook", status: "done"});
    const done = render(<MessageList threads={store.getSnapshot().staticThreads} terminalWidth={40}/>);
    expect(done.lastFrame()).toContain("检查完成");
    expect(done.lastFrame()?.match(/Hook PostToolBatch/g)).toHaveLength(1);
    screen.unmount(); done.unmount();
});

test("SDK Hook Item 保留同一执行身份，成功不伪装成错误诊断", async () => {
    const events: ThreadEventPayload[] = [];
    const adapter = new SDKEventAdapter("turn", event => {events.push(event);});
    await adapter.handleAgentEvent(started); await adapter.handleAgentEvent(completed);
    expect(events.map(event => event.type)).toEqual(["item.started", "item.completed"]);
    const items = events.flatMap(event => "item" in event ? [event.item] : []);
    expect(items[0]?.id).toBe(items[1]?.id);
    expect(items[0]).toMatchObject({type: "hook", status: "in_progress"});
    expect(items[1]).toMatchObject({type: "hook", status: "completed", execution: {userMessage: "检查完成"}});
});

test("未启动的超预算 Hook 以完整的瞬时 SDK Item 报告", async () => {
    const events: ThreadEventPayload[] = [];
    const adapter = new SDKEventAdapter("turn", event => {events.push(event);});
    await adapter.handleAgentEvent({type: "hook_completed", execution: {...started.execution,
        outcome: "skipped_budget", durationMs: 0, message: "budget exhausted"}});
    expect(events.map(event => event.type)).toEqual(["item.started", "item.completed"]);
    expect(events[1]).toMatchObject({item: {status: "failed", execution: {outcome: "skipped_budget"}}});
});
