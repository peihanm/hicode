import { describe, expect, test } from "bun:test";
import {createFileChange, mergeFileChange} from "../../src/fileChanges/index.js";
import {limitPersistedUIEvents} from "../../src/session/index.js";
import {decodeSessionContentBlock, limitSessionUIEvents} from "../../src/session/codec.js";

describe("file change diff", () => {
  test.each([
    {name: "普通修改", content: "hello\n", status: "complete", added: 1, omitted: 0},
    {name: "恰好 10000 行", content: "x\n".repeat(10_000), status: "complete", added: 10_000, omitted: 0},
    {name: "超过 hunk 行数限制", content: "x\n".repeat(10_001), status: "truncated", added: 10_001, omitted: 1},
    {name: "恰好 1 MiB 单行", content: "x".repeat(1024 * 1024), status: "complete", added: 1, omitted: 0},
    {name: "超长单行", content: "x".repeat(1024 * 1024 + 1), status: "truncated", added: 1, omitted: 1},
    {name: "中文 emoji 按 UTF-8 字节限制", content: "中😀".repeat(150_000), status: "truncated", added: 1, omitted: 1},
  ])("$name 的展示记录可保存并恢复", ({content, status, added, omitted}) => {
    const change = createFileChange({path: "example.txt", kind: "create", oldContent: "", newContent: content});
    expect(change.diffStatus).toBe(status);
    expect(change.linesAdded).toBe(added);
    expect(change.linesRemoved).toBe(0);
    expect(change.omittedDiffLines ?? 0).toBe(omitted);
    const event = {version: 1 as const, type: "file_change" as const, turnId: "turn-1", toolCallId: "call-1", timestamp: "2026-10-23T00:00:00.000Z", change};
    expect(limitSessionUIEvents([event])).toEqual([event]);
    expect(decodeSessionContentBlock(JSON.parse(JSON.stringify({kind: "ui", value: event})))).toEqual({kind: "ui", value: event});
  });

  test("截断保留原始全文用于下一次合并，不将裁剪后的展示当作文件内容", () => {
    const content = "x\n".repeat(10_001);
    const first = createFileChange({path: "example.txt", kind: "create", oldContent: "", newContent: content});
    const second = createFileChange({path: "example.txt", kind: "update", oldContent: content, newContent: "final\n"});
    const [merged] = mergeFileChange([first], second);
    expect(merged).toMatchObject({kind: "create", scope: "turn", diffStatus: "complete", linesAdded: 1, linesRemoved: 0});
    expect(merged?.hunks[0]?.lines.map(line => line.content)).toEqual(["final"]);
  });

  test("空文件的连续编辑仍为 update，清空新文件仍为 create", () => {
    for (const kind of ["create", "update"] as const) {
      const first = createFileChange({path: "a.txt", kind, oldContent: "", newContent: "a\n"});
      const edited = createFileChange({path: "a.txt", kind: "update", oldContent: "a\n", newContent: "b\n"});
      expect(mergeFileChange([first], edited)[0]?.kind).toBe(kind);
      const second = createFileChange({path: "a.txt", kind: "update", oldContent: "a\n", newContent: ""});
      expect(mergeFileChange([first], second)[0]).toMatchObject({kind, linesAdded: 0, linesRemoved: 0});
    }
    const first = createFileChange({path: "a.txt", kind: "update", oldContent: "a\n", newContent: "b\n"});
    const cleared = createFileChange({path: "a.txt", kind: "update", oldContent: "b\n", newContent: ""});
    expect(mergeFileChange([first], cleared)[0]).toMatchObject({kind: "update", linesRemoved: 1});
  });

  test("删除后重建是 update；创建后删除保留操作；空内容不绕过存在性校验", () => {
    const created = createFileChange({path: "a.txt", kind: "create", oldContent: "", newContent: ""});
    const deleted = createFileChange({path: "a.txt", kind: "delete", oldContent: "", newContent: ""});
    expect(mergeFileChange([deleted], created)[0]).toMatchObject({kind: "update"});
    expect(mergeFileChange([created], deleted)).toEqual([created, deleted]);
    const updated = createFileChange({path: "a.txt", kind: "update", oldContent: "", newContent: "x\n"});
    expect(mergeFileChange([deleted], updated)).toEqual([deleted, updated]);
  });

  test("断开的修改链后续可衔接时也不覆盖之前的记录或其他文件", () => {
    const first = createFileChange({path: "a.txt", kind: "update", oldContent: "A", newContent: "B"});
    const other = createFileChange({path: "b.txt", kind: "create", oldContent: "", newContent: "other"});
    const second = createFileChange({path: "a.txt", kind: "update", oldContent: "X", newContent: "Y"});
    const third = createFileChange({path: "a.txt", kind: "update", oldContent: "Y", newContent: "Z"});
    const changes = mergeFileChange(mergeFileChange([first, other], second), third);
    expect(changes).toEqual([first, other, second, third]);
    expect(changes.every(change => change.scope === undefined)).toBe(true);
  });

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
      newContent: Array.from(
        { length: 30_000 },
        (_, index) => `line-${index}-${"x".repeat(80)}`,
      ).join("\n"),
    });
    expect(change.diffStatus).toBe("truncated");
    expect(change.linesAdded).toBe(30_000);
    expect(change.omittedDiffLines).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify({...change, scope: "turn"}))).toBeLessThanOrEqual(2 * 1024 * 1024);
    const event = {version: 1 as const, type: "file_change" as const, turnId: "turn-large", toolCallId: "call-large", timestamp: "2026-10-23T00:00:00.000Z", change: {...change, scope: "turn" as const}};
    expect(limitSessionUIEvents([event])).toEqual([event]);
    expect(decodeSessionContentBlock(JSON.parse(JSON.stringify({kind: "ui", value: event})))).toEqual({kind: "ui", value: event});
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

  test("持久化时用同 turn 同路径的最终净变更替换中间 patch", () => {
    const first = createFileChange({
      path: "a.txt",
      kind: "create",
      oldContent: "",
      newContent: "a\n",
    });
    const final = createFileChange({
      path: "a.txt",
      kind: "create",
      oldContent: "",
      newContent: "a\nb\n",
    });
    final.scope = "turn";
    const events = [first, final].map((change, index) => ({
      version: 1 as const,
      type: "file_change" as const,
      turnId: "turn-1",
      toolCallId: `call-${index}`,
      timestamp: `2026-07-12T00:00:0${index}.000Z`,
      change,
    }));

    expect(limitPersistedUIEvents(events)).toEqual([events[1]]);
  });
});
