import {SessionUIEventCollector} from "../../src/session/uiEventCollector.js";
import {decodeSessionContentBlock} from "../../src/session/codec.js";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { createFileChange } from "../../src/fileChanges/diff.js";
import { reduceThreads, threadsFromHistory } from "../../src/ui/conversation/threadReducer.js";
import type { UIThread } from "../../src/ui/conversation/types.js";
import type { Message } from "../../src/llm/types.js";
import { MessageList } from "../../src/ui/conversation/MessageList.js";
import {StructuredDiff} from "../../src/ui/fileChanges/StructuredDiff.js";

afterEach(() => cleanup());

function addChange(
  threads: UIThread[],
  toolCallId: string,
  path: string,
  before: string,
  after: string
): UIThread[] {
  const started = reduceThreads(threads, {
    type: "tool_call_start",
    turnId: "turn-1",
    toolCallId,
    name: "edit_file",
    args: JSON.stringify({ path }),
  });
  return reduceThreads(started, {
    type: "tool_call_end",
    turnId: "turn-1",
    toolCallId,
    result: `Modified ${path}`,
    outcome: "ok",
    uiData: {
      type: "file_change",
      change: createFileChange({
        path,
        kind: "update",
        oldContent: before,
        newContent: after,
      }),
    },
  });
}

describe("file change diff UI", () => {
  test("超限省略与可展开折叠分别提示，序列化恢复后提示一致", () => {
    const change = createFileChange({path: "large.txt", kind: "create", oldContent: "", newContent: "x".repeat(1024 * 1024 + 1)});
    const event = {version: 1 as const, type: "file_change" as const, turnId: "turn-large", toolCallId: "call-large", timestamp: "2026-10-23T00:00:00.000Z", change};
    const restored = decodeSessionContentBlock(JSON.parse(JSON.stringify({kind: "ui", value: event})));
    if (restored.kind !== "ui" || restored.value.type !== "file_change") throw new Error("Expected file change");
    for (const current of [change, restored.value.change]) {
      const frame = render(<StructuredDiff hunks={current.hunks} omittedDiffLines={current.omittedDiffLines} width={80} expanded={false} />).lastFrame() ?? "";
      expect(frame).toContain("1 diff line omitted (display limit)");
      expect(frame).not.toContain("ctrl+o");
    }
    const small = createFileChange({path: "small.txt", kind: "create", oldContent: "", newContent: "a\nb\n"});
    const folded = render(<StructuredDiff hunks={small.hunks} omittedDiffLines={3} width={80} expanded={false} defaultMaxLines={1} />).lastFrame() ?? "";
    expect(folded).toContain("1 more diff line · ctrl+o to expand");
    expect(folded).toContain("3 diff lines omitted (display limit)");
  });

  test("新文件在同一 turn 修复后只展示最终净 diff", () => {
    let threads: UIThread[] = [];
    const changes = [
      createFileChange({
        path: "app.py",
        kind: "create",
        oldContent: "",
        newContent: "alpha\nbroken\n",
      }),
      createFileChange({
        path: "app.py",
        kind: "update",
        oldContent: "alpha\nbroken\n",
        newContent: "alpha\nfixed\nfinal\n",
      }),
    ];
    for (const [index, change] of changes.entries()) {
      const toolCallId = `write-${index}`;
      threads = reduceThreads(threads, {
        type: "tool_call_start",
        turnId: "turn-create",
        toolCallId,
        name: index === 0 ? "write_file" : "edit_file",
        args: JSON.stringify({ path: "app.py" }),
      });
      threads = reduceThreads(threads, {
        type: "tool_call_end",
        turnId: "turn-create",
        toolCallId,
        result: "ok",
        outcome: "ok",
        uiData: { type: "file_change", change },
      });
    }

    const frame = render(<MessageList threads={threads} />).lastFrame() ?? "";
    expect(frame).toContain("● Building");
    expect(frame).toContain("Created 1 file (+3 -0)");
    expect(frame).toContain("app.py (+3 -0, new file)");
    expect(frame).toContain("+ fixed");
    expect(frame).not.toContain("- broken");
    expect(frame).not.toContain("write_file");
    expect(frame).not.toContain("edit_file");

    const transcript = render(
      <MessageList threads={threads} transcript />
    ).lastFrame() ?? "";
    expect(transcript).toContain("+ fixed");
    expect(transcript).not.toContain("- broken");
  });

  test("同一 turn 聚合多个文件并隐藏重复工具成功行", () => {
    let threads: UIThread[] = [];
    threads = addChange(
      threads,
      "edit-a",
      "src/a.ts",
      "const value = 1;\n",
      "const value = 2;\n"
    );
    threads = addChange(
      threads,
      "edit-b",
      "src/b.ts",
      "export {};\n",
      "export const ready = true;\n"
    );

    expect(threads.filter((thread) => thread.role === "file_change_group")).toHaveLength(1);
    const instance = render(<MessageList threads={threads} />);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("● Building");
    expect(frame).toContain("Edited 2 files (+2 -2)");
    expect(frame).toContain("src/a.ts (+1 -1)");
    expect(frame).toContain("- const value = 1;");
    expect(frame).toContain("+ const value = 2;");
    expect(frame).not.toContain("edit_file");

    const transcript = render(
      <MessageList threads={threads} transcript />
    ).lastFrame() ?? "";
    expect(transcript).toContain("- const value = 1;");
    expect(transcript).toContain("+ const value = 2;");
  });

  test("失败的文件工具不进入成功修改汇总", () => {
    let threads: UIThread[] = reduceThreads([], {
      type: "tool_call_start",
      turnId: "turn-failed",
      toolCallId: "failed-edit",
      name: "edit_file",
      args: JSON.stringify({ path: "a.ts" }),
    });
    threads = reduceThreads(threads, {
      type: "tool_call_end",
      turnId: "turn-failed",
      toolCallId: "failed-edit",
      result: "Permission denied",
      outcome: "denied",
    });
    const frame = render(<MessageList threads={threads} />).lastFrame() ?? "";
    expect(frame).toContain("● Edit a.ts");
    expect(frame).toContain("Permission denied");
    expect(frame).not.toContain("Edited 1 file");
  });

  test("从 Session conversation 与 uiEvents 恢复修改汇总", () => {
    const history: Message[] = [
      { role: "user", origin: "user" as const, content: "修改文件" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "restore-edit",
          type: "function",
          function: { name: "edit_file", arguments: "{}" },
        }],
      },
      { role: "tool", content: "Modified", tool_call_id: "restore-edit" },
    ];
    const change = createFileChange({
      path: "restored.ts",
      kind: "update",
      oldContent: "old\n",
      newContent: "new\n",
    });
    const threads = threadsFromHistory(history, [{
      version: 1,
      type: "file_change",
      turnId: "restored-turn",
      toolCallId: "restore-edit",
      timestamp: "2026-07-12T00:00:00.000Z",
      change,
    }]);
    const frame = render(<MessageList threads={threads} />).lastFrame() ?? "";
    expect(frame).toContain("Edited 1 file (+1 -1)");
    expect(frame).toContain("restored.ts");
    expect(frame).not.toContain("edit_file");
  });
});


test("output delivery failure retains both the committed diff and visible failure", () => {
    const change = createFileChange({path: "a.ts", kind: "update", oldContent: "before\n", newContent: "after\n"});
    const started = reduceThreads([], {type: "tool_call_start", turnId: "turn", toolCallId: "edit", name: "edit_file", args: '{"path":"a.ts"}'});
    const threads = reduceThreads(started, {type: "tool_call_end", turnId: "turn", toolCallId: "edit", outcome: "output_failed",
        result: "Full output delivery failed", uiData: {type: "file_change", change}});
    const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
    expect(frame).toContain("Full output delivery failed");
    expect(frame).toContain("after");
    expect(threads.find(thread => thread.role === "tool_call")).not.toHaveProperty("hiddenByFileChange", true);
});


test("output_failed survives persisted UI replay without hiding its error or committed change", () => {
    const collector = new SessionUIEventCollector();
    const change = createFileChange({path: "a.ts", kind: "update", oldContent: "before\n", newContent: "after\n"});
    collector.handleEvent({type: "tool_call_start", turnId: "turn", toolCallId: "edit", name: "edit_file", args: '{"path":"a.ts"}'});
    collector.handleEvent({type: "tool_call_end", turnId: "turn", toolCallId: "edit", outcome: "output_failed",
        result: "Full output delivery failed", uiData: {type: "file_change", change}});
    const events = collector.getEvents();
    for (const event of events) expect(() => decodeSessionContentBlock({kind: "ui", value: event})).not.toThrow();
    const history: Message[] = [{role: "assistant", content: null, tool_calls: [{id: "edit", type: "function", function: {name: "edit_file", arguments: '{"path":"a.ts"}'}}]},
        {role: "tool", tool_call_id: "edit", content: "Full output delivery failed"}];
    const threads = threadsFromHistory(history, [...events]);
    expect(threads.find(thread => thread.role === "tool_call")).toMatchObject({outcome: "output_failed"});
    const frame = render(<MessageList threads={threads}/>).lastFrame() ?? "";
    expect(frame).toContain("Full output delivery failed");
    expect(frame).toContain("after");
});
