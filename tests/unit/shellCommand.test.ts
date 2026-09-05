import { describe, expect, test } from "bun:test";
import {
  generateShellAllowPattern,
  hasShellBackgroundOperator,
  isShellCommandReadOnly,
  splitShellSubCommands,
} from "../../src/permissions/shellCommand.js";

describe("shell command permissions", () => {
  test("识别只读命令和只读 git 子命令", () => {
    expect(isShellCommandReadOnly("pwd && git status --short")).toBe(true);
    expect(isShellCommandReadOnly("rg TODO src | head -20")).toBe(true);
    expect(isShellCommandReadOnly("git add src/a.ts")).toBe(false);
    expect(isShellCommandReadOnly("pwd\nrm result.txt")).toBe(false);
  });

  test("重定向和命令替换不会被当作只读", () => {
    expect(isShellCommandReadOnly("echo ok > result.txt")).toBe(false);
    expect(isShellCommandReadOnly("echo ok>result.txt")).toBe(false);
    expect(isShellCommandReadOnly("echo $(whoami)")).toBe(false);
    expect(isShellCommandReadOnly("cat `which node`")).toBe(false);
    expect(isShellCommandReadOnly("sort -o result.txt input.txt")).toBe(false);
    expect(isShellCommandReadOnly("rg --pre ./transform TODO")).toBe(false);
    expect(isShellCommandReadOnly("tree -o result.txt")).toBe(false);
    expect(isShellCommandReadOnly("sort --compress-program=./run input")).toBe(false);
    expect(isShellCommandReadOnly("git diff --ext-diff")).toBe(false);
    expect(isShellCommandReadOnly("git grep --open-files-in-pager=./run term")).toBe(false);
    expect(isShellCommandReadOnly("echo 'literal > text'")).toBe(true);
  });

  test("只识别未转义且未引用的后台操作符", () => {
    expect(hasShellBackgroundOperator("node server.js &")).toBe(true);
    expect(hasShellBackgroundOperator("node server.js& echo ready")).toBe(true);
    expect(hasShellBackgroundOperator("echo ok && echo done")).toBe(false);
    expect(hasShellBackgroundOperator("echo '&' \"&\" \\&")).toBe(false);
    expect(hasShellBackgroundOperator("command &>output.log")).toBe(false);
    expect(hasShellBackgroundOperator("command >& output.log")).toBe(false);
    expect(isShellCommandReadOnly("echo ready &")).toBe(false);
  });

  test("拆分组合命令并生成逐段 allow pattern", () => {
    expect(splitShellSubCommands("npm test && git status | head")).toEqual([
      "npm test",
      "git status",
      "head",
    ]);
    expect(generateShellAllowPattern("npm test && git status")).toBe(
      "npm test:* | git status:*"
    );
  });

  test("引号、转义与选项语义一致，无法确定时保守拒绝只读", () => {
    for (const command of [
      'sort "-o" out input', "sort -rout input", "s''ort -oout input",
      'sort \\-o out input', 'sort --out=out input', 'tree -aoout',
      'rg "--pre" ./run term', "rg --hostname-b=./run term", "git grep -Ocat term",
      'git log "--output=out"', 'uniq input out', 'uniq - out', 'uniq -- input -out', 'file -C -m magic', 'date -s tomorrow',
      'sort $FLAGS input', 'cat *.txt', 'echo $(touch out)', 'cat <<EOF\ndata\nEOF',
      'echo "unterminated', 'pwd &&', 'pwd ||', 'pwd &', 'pwd; (echo ok)',
    ]) expect(isShellCommandReadOnly(command)).toBe(false);
    for (const command of [
      'sort -rn input', 'sort "input name"', 'git "status" --short',
      'echo "a | b && c"', "echo 'literal $HOME > text'", 'echo a\\;b',
      'pwd &&\n git status', 'sort -r\\\nn input', 'pwd;\n',
    ]) expect(isShellCommandReadOnly(command)).toBe(true);
    expect(splitShellSubCommands('echo "a | b" && git status')).toEqual(['echo "a | b"', 'git status']);
    expect(generateShellAllowPattern('echo $(touch out)')).toBeNull();
    expect(generateShellAllowPattern('echo ok > out')).toBeNull();
    expect(generateShellAllowPattern('git "status"')).toBe('git status:*');
  });

});
