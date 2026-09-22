import {expect, test} from "bun:test";
import {ResponseDraft} from "../../src/agent/draft.js";
import type {AgentEvent} from "../../src/agent/types.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 120));

test("stream snapshots retain the beginning past 8k, with an explicit stable display cap", async () => {
    const events: AgentEvent[] = [];
    const draft = new ResponseDraft(event => {events.push(event);});
    await draft.update({type: "delta", text: "BEGIN " + "a".repeat(10_000)});
    expect(events[0]).toMatchObject({type: "assistant_draft", text: "BEGIN " + "a".repeat(10_000), truncated: false});
    await draft.update({type: "delta", text: "b".repeat(210_000)});
    await settle();
    const capped = events.at(-1);
    if (capped?.type !== "assistant_draft") throw new Error("Missing snapshot");
    expect(capped.text).toStartWith("BEGIN ");
    expect(capped.text).toHaveLength(200_000);
    expect(capped.truncated).toBe(true);
    await draft.update({type: "delta", text: "EXTRA"});
    await settle();
    expect(events.at(-1)).toMatchObject({text: capped.text, truncated: true});
    await draft.finish("discarded");
});

test("正文最后一段在没有后续 delta 时也会补发", async () => {
    const events: AgentEvent[] = [];
    const draft = new ResponseDraft(event => {events.push(event);});
    try {
        await draft.update({type: "delta", text: "我已经了解全貌，现在"});
        await draft.update({type: "delta", text: "写一份说明文档。"});
        await settle();
        expect(events.at(-1)).toMatchObject({type: "assistant_draft", text: "我已经了解全貌，现在写一份说明文档。"});
        expect(events).toHaveLength(2);
        await settle();
        expect(events).toHaveLength(2);
    } finally {await draft.finish("discarded");}
});

test.each(["committed", "discarded"] as const)("%s 取消尾部定时器，旧请求不能覆盖新草稿", async disposition => {
    const events: AgentEvent[] = [];
    const draft = new ResponseDraft(event => {events.push(event);});
    await draft.update({type: "delta", text: "old"});
    await draft.update({type: "delta", text: " pending"});
    const oldId = await draft.finish(disposition);
    await draft.update({type: "delta", text: "new"});
    await settle();
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({type: "assistant_draft_end", responseId: oldId, disposition});
    expect(events[2]).toMatchObject({type: "assistant_draft", text: "new"});
    await draft.finish("discarded");
});

test("结束等待已开始的异步发布，end 始终在旧草稿之后", async () => {
    const events: AgentEvent[] = [];
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => {start = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const draft = new ResponseDraft(async event => {
        if (event.type === "assistant_draft" && event.text === "ab") {start(); await gate;}
        events.push(event);
    });
    await draft.update({type: "delta", text: "a"});
    await draft.update({type: "delta", text: "b"});
    await started;
    const finished = draft.finish("discarded");
    expect(events).toHaveLength(1);
    release();
    await finished;
    expect(events.map(event => event.type)).toEqual(["assistant_draft", "assistant_draft", "assistant_draft_end"]);
});

test("异步草稿发布失败由 owner 消费，仍清理请求", async () => {
    const events: AgentEvent[] = [];
    const draft = new ResponseDraft(event => {
        if (event.type === "assistant_draft" && event.text === "ab") throw new Error("sink closed");
        events.push(event);
    });
    await draft.update({type: "delta", text: "a"});
    await draft.update({type: "delta", text: "b"});
    await settle();
    await expect(draft.finish("discarded")).rejects.toThrow("sink closed");
    expect(events.at(-1)?.type).toBe("assistant_draft_end");
    await settle();
    expect(events).toHaveLength(2);
});
