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
        "default",
        "--collaboration-mode=plan",
      ])
    ).toMatchObject({
      printPrompt: "检查项目",
      outputFormat: "json",
      permissionMode: "default",
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

  test("解析显式 checkpoint rewind", () => {
    expect(
      parseCliArgs([
        "-r",
        "session-1",
        "--rewind",
        "checkpoint-1",
        "--output-format",
        "json",
      ])
    ).toMatchObject({
      resumeMode: {kind: "session", sessionId: "session-1"},
      rewindCheckpointId: "checkpoint-1",
      outputFormat: "json",
    });
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
      parseCliArgs(["--model=deepseek-v4-pro", "--source", "DEEPSEEK"])
    ).toMatchObject({
      model: "deepseek-v4-pro",
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
    ).toThrow("必须和 -r <sessionId>");
  });
});

test("对话分支参数要求显式 Session 且不与执行或文件恢复混用", () => {
    expect(parseCliArgs(["-r", "source", "--fork-from=point", "--output-format=json"]))
        .toMatchObject({forkCheckpointId: "point", resumeMode: {kind: "session", sessionId: "source"}, outputFormat: "json"});
    for (const args of [["--fork-from", "point"], ["-r", "source", "--fork-from="],
        ["-r", "source", "--fork-from", "point", "--rewind", "other"], ["-r", "source", "--fork-from", "point", "-p", "run"]]) {
        expect(() => parseCliArgs(args)).toThrow();
    }
});
