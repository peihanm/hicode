import { describe, expect, test } from "bun:test";
import {
  createHeadlessCli,
  type HeadlessProcessAdapter,
} from "../../src/headless/cli.js";
import type {
  HeadlessOptions,
  HeadlessRunSummary,
} from "../../src/headless/types.js";
import { createTestSettings } from "../helpers/runtimeResources.js";

function options(format: "text" | "json" = "json"): HeadlessOptions {
  return {
    cwd: "/tmp/project",
    settings: createTestSettings(),
    prompt: "hello",
    resumeMode: { kind: "none" },
    outputFormat: format,
  };
}

function summary(exitCode = 0): HeadlessRunSummary {
  return {
    ok: exitCode === 0,
    exitCode,
    sessionId: "session-1",
    reason: "completed",
    iterations: 1,
    reply: "done",
    permissionMode: "default",
    toolCalls: [],
    permissionDenials: [],
    toolFailures: [],
    subagents: [],
    fileChanges: [],
    mcpServers: [],
  };
}

function createAdapter() {
  let listener: (() => void) | undefined;
  const state = {
    removed: false,
    exitCode: undefined as number | undefined,
    stdout: [] as string[],
    stderr: [] as string[],
  };
  const adapter: HeadlessProcessAdapter = {
    onceSigint(next) {
      listener = next;
    },
    removeSigint(removed) {
      state.removed = removed === listener;
    },
    setExitCode(code) {
      state.exitCode = code;
    },
    async writeStdout(text) {
      state.stdout.push(text);
    },
    writeStderr(text) {
      state.stderr.push(text);
    },
  };
  return { adapter, state, sigint: () => listener?.() };
}

describe("headless CLI adapter", () => {
  test("正常结果设置 summary exit code 并清理 listener", async () => {
    const fixture = createAdapter();
    const runCli = createHeadlessCli({
      adapter: fixture.adapter,
      runner: async () => summary(3),
    });
    await runCli(options());
    expect(fixture.state.exitCode).toBe(3);
    expect(fixture.state.removed).toBe(true);
  });

  test("JSON error 只写 stdout，text error 只写 stderr", async () => {
    const json = createAdapter();
    await createHeadlessCli({
      adapter: json.adapter,
      runner: async () => {
        throw new Error("json boom");
      },
    })(options("json"));
    expect(JSON.parse(json.state.stdout[0]!)).toMatchObject({
      ok: false,
      exitCode: 1,
      error: "json boom",
    });
    expect(json.state.stderr).toEqual([]);
    expect(json.state.exitCode).toBe(1);

    const text = createAdapter();
    await createHeadlessCli({
      adapter: text.adapter,
      runner: async () => {
        throw new Error("text boom");
      },
    })(options("text"));
    expect(text.state.stdout).toEqual([]);
    expect(text.state.stderr[0]).toContain("\x1b[31mtext boom");
    expect(text.state.exitCode).toBe(1);
  });

  test("SIGINT abort signal 使用 sigint reason", async () => {
    const fixture = createAdapter();
    const runCli = createHeadlessCli({
      adapter: fixture.adapter,
      runner: async (_options, signal) => {
        fixture.sigint();
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe("sigint");
        return summary(130);
      },
    });
    await runCli(options());
    expect(fixture.state.exitCode).toBe(130);
    expect(fixture.state.removed).toBe(true);
  });

  test("error writer 自身失败仍移除 listener", async () => {
    const fixture = createAdapter();
    fixture.adapter.writeStdout = async () => {
      throw new Error("stdout failed");
    };
    const runCli = createHeadlessCli({
      adapter: fixture.adapter,
      runner: async () => {
        throw new Error("run failed");
      },
    });
    await expect(
      runCli(options())
    ).rejects.toThrow("stdout failed");
    expect(fixture.state.removed).toBe(true);
  });
});
