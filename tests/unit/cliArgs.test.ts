import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli/args.js";

describe("parseCliArgs", () => {
  test("解析 headless、输出格式和权限模式", () => {
    expect(
      parseCliArgs([
        "--print",
        "检查项目",
        "--output-format=json",
        "--permission-mode",
        "ask",
        "--collaboration-mode=plan",
      ])
    ).toMatchObject({
      printPrompt: "检查项目",
      outputFormat: "json",
      permissionMode: "ask",
      collaborationMode: "plan",
      resumeMode: { kind: "none" },
    });
  });

  test("解析 continue 和带 id 的 resume", () => {
    expect(parseCliArgs(["--continue"]).resumeMode).toEqual({ kind: "continue" });
    expect(parseCliArgs(["--resume=session-1"]).resumeMode).toEqual({
      kind: "session",
      sessionId: "session-1",
    });
  });

  test("删除的回退和分支参数不再接受", () => {
    for (const option of ["--rewind", "--fork-from"]) expect(() => parseCliArgs(["-r", "session", option, "old"])).toThrow("未知参数");
  });

  test("解析本次启动的 model 和 source 覆盖", () => {
    expect(
      parseCliArgs(["--model", "glm-5.2", "--source=GLM"])
    ).toMatchObject({
      model: "glm-5.2",
      source: "glm",
    });
    expect(
      parseCliArgs(["--model=qwen3.6-plus", "--source", "QWEN"])
    ).toMatchObject({
      model: "qwen3.6-plus",
      source: "qwen",
    });
    expect(
      parseCliArgs(["--model=deepseek-pro", "--source", "DEEPSEEK"])
    ).toMatchObject({
      model: "deepseek-pro",
      source: "deepseek",
    });
  });

  test("拒绝互斥或不完整参数", () => {
    expect(() => parseCliArgs(["--continue", "--resume", "abc"])).toThrow(
      "只能指定一个恢复参数"
    );
    expect(() => parseCliArgs(["--output-format", "json"])).toThrow(
      "--output-format 只能用于"
    );
    expect(() => parseCliArgs(["--permission-mode", "unknown"])).toThrow(
      "未知权限模式"
    );
    expect(() => parseCliArgs(["--source", "CODEX"])).toThrow(
      "未知模型来源"
    );
    for (const legacyMode of [
      "acceptEdits",
      "plan",
      "dontAsk",
      "normal",
      "readonly",
      "read-only",
      "read",
      "bypass",
      "bypasspermissions",
      "bypass-permissions",
      "danger",
    ]) {
      expect(() =>
        parseCliArgs(["--permission-mode", legacyMode])
      ).toThrow("未知权限模式");
    }
    expect(() => parseCliArgs(["--collaboration-mode", "unknown"])).toThrow(
      "未知协作模式"
    );
    expect(() => parseCliArgs(["--collaboration-mode", "PLAN"])).toThrow(
      "未知协作模式"
    );
    expect(() => parseCliArgs(["--model="])).toThrow("--model 需要提供非空");
    expect(() => parseCliArgs(["--source", "unknown"])).toThrow(
      "未知模型来源"
    );
    expect(() =>
      parseCliArgs(["--rewind", "checkpoint-1"])
    ).toThrow("未知参数");
  });
});

test("--image accepts repeated explicit paths, keeps spaces and rejects overflow and removed flags", () => {
    expect(parseCliArgs(["--image", "截图 with space.png", "-i", "b.jpg", "--image=c.webp"]).images).toEqual(["截图 with space.png", "b.jpg", "c.webp"]);
    expect(parseCliArgs(["-p", "compare", "--image", "x.png"]).printPrompt).toBe("compare");
    expect(() => parseCliArgs(["--image"])).toThrow("路径");
    expect(() => parseCliArgs(Array.from({length: 9}, () => "--image=x.png"))).toThrow("8 张");
    expect(() => parseCliArgs(["--image=x.png", "-r", "s", "--rewind", "c"])).toThrow("未知参数");
});
