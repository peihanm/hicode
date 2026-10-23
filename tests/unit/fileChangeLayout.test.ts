import { describe, expect, test } from "bun:test";
import { createFileChange } from "../../src/fileChanges/index.js";
import { wrapDisplayText } from "../../src/ui/fileChanges/layout.js";
import {
  getWordParts,
  pairChangedLines,
} from "../../src/ui/fileChanges/wordDiff.js";

describe("file change layout", () => {
  test("按终端列宽换行且不拆分 grapheme", () => {
    expect(wrapDisplayText("中文ab", 4)).toEqual(["中文", "ab"]);
    expect(wrapDisplayText("A👨‍👩‍👧‍👦B", 3)).toEqual(["A👨‍👩‍👧‍👦", "B"]);
  });

  test("相邻删除和新增行一一配对", () => {
    const change = createFileChange({
      path: "a.ts",
      kind: "update",
      oldContent: "const oldName = 1;\n",
      newContent: "const newName = 1;\n",
    });
    const hunk = change.hunks[0]!;
    const pairs = pairChangedLines(hunk);
    const removeIndex = hunk.lines.findIndex((line) => line.type === "remove");
    const addIndex = hunk.lines.findIndex((line) => line.type === "add");
    expect(pairs.get(removeIndex)).toBe(addIndex);
    expect(pairs.get(addIndex)).toBe(removeIndex);
  });

  test("小范围修改生成词级强调，大范围修改退回整行", () => {
    const parts = getWordParts(
      "const oldName = value;",
      "const newName = value;",
      "remove"
    );
    expect(parts?.some((part) => part.changed && part.value === "oldName")).toBe(true);
    expect(getWordParts("completely different", "nothing alike here", "add")).toBeNull();
  });
});
