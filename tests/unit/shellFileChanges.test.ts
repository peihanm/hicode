import {expect, test} from "bun:test";
import {createFileChange} from "../../src/fileChanges/index.js";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {SDKEventAdapter} from "../../src/sdk/eventAdapter.js";
import type {ThreadEventPayload} from "../../src/sdk/protocol.js";
import type {AgentEvent} from "../../src/agent/types.js";

test("失败 Bash 的多个变更进入 UI、SDK、持久化，恢复后保留失败命令", async () => {
    const changes = ["a.txt", "b.txt"].map(path => createFileChange({path, kind: "create", oldContent: "", newContent: "generated"}));
    const start: AgentEvent = {type: "tool_call_start", turnId: "turn", toolCallId: "shell", name: "bash", args: "{\"command\":\"test\"}"};
    const end: AgentEvent = {type: "tool_call_end", turnId: "turn", toolCallId: "shell", outcome: "failed", result: "exit 1", uiData: {type: "file_changes", changes}};
    const store = new UITurnEventStore();
    const events: ThreadEventPayload[] = [];
    const sdk = new SDKEventAdapter("turn", event => {events.push(event);});
    for (const event of [start, end]) {store.handleEvent(event); await sdk.handleAgentEvent(event);}
    await sdk.finish("completed");
    expect(store.getSnapshot().threads.find(thread => thread.role === "tool_call")).toMatchObject({outcome: "failed", result: "exit 1"});
    expect(store.getPersistedUIEvents().filter(event => event.type === "file_change")).toHaveLength(2);
    expect(sdk.getPersistedUIEvents().filter(event => event.type === "file_change")).toHaveLength(2);
    expect(events.filter(event => event.type === "item.completed" && event.item.type === "file_change")).toEqual([expect.objectContaining({item: expect.objectContaining({changes})})]);
    const restored = new UITurnEventStore({history: [
        {role: "assistant", content: null, tool_calls: [{id: "shell", type: "function", function: {name: "bash", arguments: start.args}}]},
        {role: "tool", tool_call_id: "shell", content: "exit 1"},
    ], uiEvents: [...store.getPersistedUIEvents()]});
    const tool = restored.getSnapshot().threads.find(thread => thread.role === "tool_call");
    expect(tool).toMatchObject({outcome: "failed", result: "exit 1"});
    expect(tool && "hiddenByFileChange" in tool && tool.hiddenByFileChange).not.toBe(true);
    expect(restored.getSnapshot().threads.find(thread => thread.role === "file_change_group")).toMatchObject({changes: expect.arrayContaining([expect.objectContaining({path: "a.txt"}), expect.objectContaining({path: "b.txt"})])});
});
