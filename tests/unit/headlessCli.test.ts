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
import {createTestStorage} from "../helpers/tempProject.js";
import {
  CLI_FILE_SOURCES,
  createHiCodeRootConfiguration,
} from "../../src/runtime/rootConfiguration.js";

function options(format: "text" | "json" = "json"): HeadlessOptions {
  const cwd = "/tmp/project";
  return {
    configuration: createHiCodeRootConfiguration({
      cwd,
      workspaceBoundary: "/",
      storage: createTestStorage(cwd),
      settings: createTestSettings(),
      fileSources: CLI_FILE_SOURCES,
    }),
    prompt: "hello",
    resumeMode: { kind: "none" },
    outputFormat: format,
  };
}

function summary(exitCode = 0): HeadlessRunSummary {
  return {
    ok: exitCode === 0,
    exitCode,
    threadId: "session-1", turnId: "turn-1", stopReason: "completed", iterations: 1,
    finalResponse: "done", usage: null, durationMs: 0, items: [],
  };
}

function createAdapter() {
  let sigintListener: (() => void) | undefined;
  let sigtermListener: (() => void) | undefined;
  const state = {
    sigintRemoved: false,
    sigtermRemoved: false,
    exitCode: undefined as number | undefined,
    stdout: [] as string[],
    stderr: [] as string[],
  };
  const adapter: HeadlessProcessAdapter = {
    onceSigint(next) {
      sigintListener = next;
    },
    onceSigterm(next) {
      sigtermListener = next;
    },
    removeSigint(removed) {
      state.sigintRemoved = removed === sigintListener;
    },
    removeSigterm(removed) {
      state.sigtermRemoved = removed === sigtermListener;
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
  return {
    adapter,
    state,
    sigint: () => sigintListener?.(),
    sigterm: () => sigtermListener?.(),
  };
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
    expect(fixture.state.sigintRemoved).toBe(true);
    expect(fixture.state.sigtermRemoved).toBe(true);
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
    expect(fixture.state.sigintRemoved).toBe(true);
    expect(fixture.state.sigtermRemoved).toBe(true);
  });

  test("SIGTERM abort signal 使用 shutdown reason", async () => {
    const fixture = createAdapter();
    const runCli = createHeadlessCli({
      adapter: fixture.adapter,
      runner: async (_options, signal) => {
        fixture.sigterm();
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe("shutdown");
        return summary(130);
      },
    });
    await runCli(options());
    expect(fixture.state.exitCode).toBe(130);
    expect(fixture.state.sigintRemoved).toBe(true);
    expect(fixture.state.sigtermRemoved).toBe(true);
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
    expect(fixture.state.sigintRemoved).toBe(true);
    expect(fixture.state.sigtermRemoved).toBe(true);
  });
});
