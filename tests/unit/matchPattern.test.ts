import { describe, expect, test } from "bun:test";
import { matchPattern } from "../../src/permissions/matchPattern.js";

describe("matchPattern", () => {
  test("支持 prefix:* 旧语法", () => {
    expect(matchPattern("git add:*", "git add")).toBe(true);
    expect(matchPattern("git add:*", "git add src/a.ts")).toBe(true);
    expect(matchPattern("git add:*", "git status")).toBe(false);
  });

  test("支持通用星号并保持其余字符字面含义", () => {
    expect(matchPattern("npm *", "npm run check")).toBe(true);
    expect(matchPattern("file?.ts", "file1.ts")).toBe(false);
    expect(matchPattern("src/*.ts", "src/a.ts")).toBe(true);
  });

  test("没有通配符时要求完整匹配", () => {
    expect(matchPattern("git status", "git status")).toBe(true);
    expect(matchPattern("git status", "git status --short")).toBe(false);
  });
});
