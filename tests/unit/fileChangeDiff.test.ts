import { describe, expect, test } from "bun:test";
import {
  createFileChange,
  mergeFileChange,
  limitFileChangeUIData,
} from "../../src/fileChanges/index.js";
import {limitPersistedUIEvents} from "../../src/session/index.js";

describe("file change diff", () => {
  test("同一 turn 的连续修改合并为初始内容到最终内容", () => {
    const created = createFileChange({
      path: "new.txt",
      kind: "create",
      oldContent: "",
      newContent: "alpha\nbroken\n",
    });
    const repaired = createFileChange({
      path: "new.txt",
      kind: "update",
      oldContent: "alpha\nbroken\n",
      newContent: "alpha\nfixed\nfinal\n",
    });

    const changes = mergeFileChange([created], repaired);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "new.txt",
      kind: "create",
      scope: "turn",
      linesAdded: 3,
      linesRemoved: 0,
    });
    expect(
      changes[0]!.hunks.flatMap((hunk) => hunk.lines)
    ).not.toContainEqual(expect.objectContaining({ type: "remove" }));
    expect(JSON.stringify(changes[0])).not.toContain("oldContent");
    expect(JSON.stringify(changes[0])).not.toContain("newContent");
  });

  test("修改后回退到初始内容显示为零净改动", () => {
    const first = createFileChange({
      path: "existing.txt",
      kind: "update",
      oldContent: "original\n",
      newContent: "changed\n",
    });
    const reverted = createFileChange({
      path: "existing.txt",
      kind: "update",
      oldContent: "changed\n",
      newContent: "original\n",
    });

    expect(mergeFileChange([first], reverted)[0]).toMatchObject({
      scope: "turn",
      linesAdded: 0,
      linesRemoved: 0,
      hunks: [],
    });
  });

  test("生成带准确新旧行号和三行上下文的更新 patch", () => {
    const before = ["zero", "one", "two", "three", "four", "five"].join("\n");
    const after = ["zero", "one", "TWO", "three", "four", "five", "six"].join("\n");
    const change = createFileChange({
      path: "src/a.ts",
      kind: "update",
      oldContent: before,
      newContent: after,
    });

    expect(change).toMatchObject({
      diffStatus: "complete",
      linesAdded: 2,
      linesRemoved: 1,
    });
    const removed = change.hunks.flatMap((hunk) => hunk.lines).find(
      (line) => line.type === "remove"
    );
    const added = change.hunks.flatMap((hunk) => hunk.lines).find(
      (line) => line.type === "add" && line.content === "TWO"
    );
    expect(removed).toMatchObject({ content: "two", oldLineNumber: 3 });
    expect(added).toMatchObject({ content: "TWO", newLineNumber: 3 });
  });

  test("创建文件正确处理空文件、末尾换行和 CRLF", () => {
    expect(createFileChange({
      path: "empty.txt",
      kind: "create",
      oldContent: "",
      newContent: "",
    }).linesAdded).toBe(0);

    const change = createFileChange({
      path: "new.txt",
      kind: "create",
      oldContent: "",
      newContent: "alpha\r\nbeta\r\n",
    });
    expect(change.linesAdded).toBe(2);
    expect(change.linesRemoved).toBe(0);
    expect(
      change.hunks.flatMap((hunk) => hunk.lines).some((line) => line.content.includes("\r"))
    ).toBe(false);
  });

  test("删除文件保留删除统计并支持同 turn 净变化合并", () => {
    const deleted = createFileChange({
      path: "old.txt",
      kind: "delete",
      oldContent: "alpha\nbeta\n",
      newContent: "",
    });
    expect(deleted).toMatchObject({
      kind: "delete",
      linesAdded: 0,
      linesRemoved: 2,
    });

    const updated = createFileChange({
      path: "old.txt",
      kind: "update",
      oldContent: "alpha\nbeta\n",
      newContent: "changed\n",
    });
    const deletedAfterUpdate = createFileChange({
      path: "old.txt",
      kind: "delete",
      oldContent: "changed\n",
      newContent: "",
    });
    expect(mergeFileChange([updated], deletedAfterUpdate)[0]).toMatchObject({
      kind: "delete",
      linesAdded: 0,
      linesRemoved: 2,
    });
  });

  test("纯末尾换行变化仍然可见，追加行不重复计算原末行", () => {
    const eofOnly = createFileChange({
      path: "eof.txt",
      kind: "update",
      oldContent: "alpha",
      newContent: "alpha\n",
    });
    expect((eofOnly.linesAdded ?? 0) + (eofOnly.linesRemoved ?? 0)).toBeGreaterThan(0);

    const appended = createFileChange({
      path: "append.txt",
      kind: "update",
      oldContent: "alpha",
      newContent: "alpha\nbeta",
    });
    expect(appended.linesAdded).toBe(1);
    expect(appended.linesRemoved).toBe(0);
  });

  test("不连续修改生成多个 hunk", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line-${index}`);
    const after = [...before];
    after[1] = "changed-near-start";
    after[28] = "changed-near-end";
    const change = createFileChange({
      path: "many.txt",
      kind: "update",
      oldContent: before.join("\n"),
      newContent: after.join("\n"),
    });
    expect(change.hunks).toHaveLength(2);
    expect(change.linesAdded).toBe(2);
    expect(change.linesRemoved).toBe(2);
  });

  test("UI metadata 超限时保留总统计并截断 hunks", () => {
    const change = createFileChange({
      path: "large.txt",
      kind: "create",
      oldContent: "",
      newContent: Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"),
    });
    const limited = limitFileChangeUIData(change, 900);
    expect(limited.diffStatus).toBe("truncated");
    expect(limited.linesAdded).toBe(100);
    expect(limited.omittedDiffLines).toBeGreaterThan(0);
  });

  test("持久化 UI 事件同时遵守条数和字节配额", () => {
    const change = createFileChange({
      path: "a.txt",
      kind: "create",
      oldContent: "",
      newContent: "a\n",
    });
    const events = Array.from({ length: 5 }, (_, index) => ({
      version: 1 as const,
      type: "file_change" as const,
      turnId: `turn-${index}`,
      toolCallId: `call-${index}`,
      timestamp: "2026-07-12T00:00:00.000Z",
      change,
    }));
    expect(limitPersistedUIEvents(events, 2, 100_000).map((event) => event.turnId)).toEqual([
      "turn-3",
      "turn-4",
    ]);
    expect(limitPersistedUIEvents(events, 5, 1)).toEqual([]);
  });
});
