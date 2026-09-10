import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import {
  formatInputDivider,
  formatTurnDuration,
  createInputBox,
  InputBox,
} from "../../src/ui/input/InputBox.js";
import { layoutInputRows } from "../../src/ui/input/MultilineTextInput.js";
import type { InputHistoryStore } from "../../src/session/inputHistory/index.js";
import {getSlashCommandSuggestions} from "../../src/slash/registry.js";

afterEach(() => cleanup());

describe("multiline input box", () => {
  test("图片标签位于输入框内，参与换行但不会写入提交正文或输入历史", async () => {
    const submitted: string[] = [], saved: string[] = [];
    let removed = 0;
    const props = {disabled: false, imageCount: 2, onSubmit: (value: string) => submitted.push(value),
      onRemoveImage: () => {removed++;}, cwd: "/project", sessionId: "inline-images",
      persistentHistory: {load: async () => [], append: async (_cwd: string, _session: string, text: string) => {saved.push(text);}}};
    const instance = render(<InputBox {...props} terminalWidth={60}/>);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain("❯ [Image #1] [Image #2]");
    expect(instance.lastFrame()).not.toContain("Ask Pillar");
    instance.stdin.write("问题 [Image #1]");
    await new Promise(resolve => setTimeout(resolve, 20));
    instance.rerender(<InputBox {...props} terminalWidth={24}/>);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const line of (instance.lastFrame() ?? "").split("\n")) expect(line.length).toBeLessThanOrEqual(24);
    instance.stdin.write("\u001B[A");
    await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\u001B[B");
    await new Promise(resolve => setTimeout(resolve, 20));
    instance.stdin.write("\r");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(submitted).toEqual(["问题 [Image #1]"]);
    expect(saved).toEqual(submitted);
    instance.stdin.write("\u007f");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(removed).toBe(1);
  });

  test("图片自动导入只处理独立路径输入，保留命令参数、正文、历史和被拒绝的输入", async () => {
    const selected: string[] = [];
    const submitted: string[] = [];
    const instance = render(<InputBox disabled={false} onSubmit={value => submitted.push(value)}
      onPasteImage={path => {selected.push(path); return false;}}/>);
    await new Promise(resolve => setTimeout(resolve, 10));
    for (const text of ["请分析 /tmp/a.png", "/attach /tmp/a.png", "/tmp/a.png"]) {
      instance.stdin.write(text);
      await new Promise(resolve => setTimeout(resolve, 20));
      instance.stdin.write("\r");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(selected).toEqual(["/tmp/a.png"]);
    expect(submitted).toEqual(["请分析 /tmp/a.png", "/attach /tmp/a.png", "/tmp/a.png"]);
    instance.stdin.write("\u001B[A");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(selected).toHaveLength(1);
    expect(instance.lastFrame()).toContain("/tmp/a.png");
    instance.unmount();

    const command = render(<InputBox disabled={false} onSubmit={() => {}}
      onPasteImage={path => {selected.push(path); return true;}}/>);
    await new Promise(resolve => setTimeout(resolve, 10));
    command.stdin.write("/attach ");
    await new Promise(resolve => setTimeout(resolve, 20));
    command.stdin.write("/tmp/b.png");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(selected).toHaveLength(1);
    expect(command.lastFrame()).toContain("/attach /tmp/b.png");
  });

  test("在输入框上方独立展示运行中和已完成的 turn 总耗时", () => {
    expect(formatTurnDuration(122_999)).toBe("2m 02s");
    expect(formatTurnDuration(3_723_000)).toBe("1h 02m 03s");
    expect(formatInputDivider(60)).toBe("─".repeat(59));

    const TestInputBox = createInputBox({ now: () => 123_000 });
    const running = render(
      <TestInputBox
        disabled
        terminalWidth={60}
        startedAt={1_000}
        onSubmit={() => {}}
      />
    );
    expect(running.lastFrame()).toContain(
      "◷ Working for 2m 02s (esc to cancel)\n\n...\n─"
    );
    running.unmount();

    const completed = render(
      <InputBox
        disabled={false}
        terminalWidth={60}
        elapsedMs={122_000}
        onSubmit={() => {}}
      />
    );
    expect(completed.lastFrame()).toContain("◷ Worked for 2m 02s\n\n❯");
    expect(completed.lastFrame()).toContain(
      "Ask Pillar to build, inspect, or fix something\n─"
    );
    expect(completed.lastFrame()).not.toContain("esc to cancel");
    expect(completed.lastFrame()).not.toContain("─ Worked for");
    for (const label of ["模型请求", "工具执行", "等待确认", "重叠活动", "其他"]) {
      expect(completed.lastFrame()).not.toContain(label);
    }
  });

  test("长粘贴折叠为 Capsule 并完整提交", async () => {
    let submitted: string | undefined;
    const input = [
      "请在同一条 assistant 消息中，同时启动两个 Explore 子 Agent：",
      "",
      "1. medium 深度调查 Session 保存与恢复链路",
      "2. medium 深度调查权限系统的完整链路",
      "",
      "两个任务相互独立，必须使用两个并行的 agent tool calls。",
      "等待两者全部完成后，分别总结结论。",
    ].join("\n");
    const instance = render(
      <InputBox
        disabled={false}
        terminalWidth={90}
        onSubmit={(value) => {
          submitted = value;
        }}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write(input);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const frame = instance.lastFrame() ?? "";
    expect(submitted).toBeUndefined();
    expect(frame).toContain("[Pasted text #1 +6 lines]");
    expect(frame).not.toContain("1. medium 深度调查 Session");

    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submitted).toBe(input);
  });

  test("终端将一次长粘贴拆成相邻数据块时只显示一个 Capsule", async () => {
    let submitted: string | undefined;
    const firstChunk = "一\n二\n三\n四\n";
    const secondChunk = "五\n六\n七\n八";
    const instance = render(
      <InputBox
        disabled={false}
        terminalWidth={90}
        onSubmit={(value) => {
          submitted = value;
        }}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write(firstChunk);
    await new Promise((resolve) => setTimeout(resolve, 5));
    instance.stdin.write(secondChunk);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[Pasted text #1 +7 lines]");
    expect(frame).not.toContain("[Pasted text #2");

    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submitted).toBe(firstChunk + secondChunk);
  });

  test("可在 Capsule 前后继续输入，Backspace 一次删除整个 Capsule", async () => {
    const submitted: string[] = [];
    const content = "第一行\n第二行\n第三行\n第四行";
    const instance = render(
      <InputBox
        disabled={false}
        terminalWidth={90}
        onSubmit={(value) => submitted.push(value)}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    instance.stdin.write("前缀 ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    instance.stdin.write(content);
    await new Promise((resolve) => setTimeout(resolve, 100));
    instance.stdin.write(" 后缀");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).toContain(
      "前缀 [Pasted text #1 +3 lines] 后缀"
    );

    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submitted).toEqual([`前缀 ${content} 后缀`]);

    instance.stdin.write(content);
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\u007f");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).not.toContain("[Pasted text #1");
  });

  for (const chunkDelay of [0, 5]) {
    test(`长 Prompt 的短尾块全部折叠且立即提交无损（分块间隔 ${chunkDelay}ms）`, async () => {
      const submissions: string[] = [];
      const first = "做一个 TypeScript 和 Canvas 霓虹赛车游戏。\n" +
        "包含 60 秒挑战、驾驶、收集能量、加速、暂停和重新开始。\n" +
        "程序绘制场景并保存本地最高分。\n" +
        "直接完成实现，实际启动并验证核心";
      const tail = "玩法，最后给我启动命令和访问地址。不要提交 Git commit。";
      const view = render(<InputBox disabled={false} terminalWidth={90}
        onSubmit={value => submissions.push(value)} />);
      await new Promise(resolve => setTimeout(resolve, 10));
      view.stdin.write(first);
      if (chunkDelay) await new Promise(resolve => setTimeout(resolve, chunkDelay));
      view.stdin.write(tail.slice(0, -1));
      view.stdin.write(tail.slice(-1));
      if (chunkDelay === 0) {
        view.stdin.write("\r");
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(submissions).toEqual([first + tail]);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(view.lastFrame()).toContain("[Pasted text #1 +3 lines]");
      expect(view.lastFrame()).not.toContain("玩法");
      expect(view.lastFrame()).not.toContain("commit");
      expect(submissions).toHaveLength(0);
      view.stdin.write("\r");
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(submissions).toEqual([first + tail]);
    });
  }

  test("光标操作结束粘贴批次，回到 Capsule 末尾后的补字仍可见", async () => {
    const submissions: string[] = [];
    const pasted = "第一行\n第二行\n第三行\n第四行";
    const view = render(<InputBox disabled={false} terminalWidth={90}
      onSubmit={value => submissions.push(value)} />);
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write(pasted);
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write("\u001b[D");
    view.stdin.write("\u001b[C");
    view.stdin.write("补充说明");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain("[Pasted text #1 +3 lines]补充说明");
    view.stdin.write("\r");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(submissions).toEqual([pasted + "补充说明"]);
  });

  test("按终端显示宽度折行且保留空行", () => {
    expect(layoutInputRows("1234中文\n\nend", 6)).toEqual([
      { start: 0, end: 5, text: "1234中" },
      { start: 5, end: 6, text: "文" },
      { start: 7, end: 7, text: "" },
      { start: 8, end: 11, text: "end" },
    ]);
  });

  test("Slash Tab 补全后光标跟随到命令末尾", async () => {
    let submitted: string | undefined;
    const instance = render(
      <InputBox
        disabled={false}
        terminalWidth={60}
        onSubmit={(value) => {
          submitted = value;
        }}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("/co");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("focus");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submitted).toBe("/compact focus");
  });

  test("Slash 候选显示在输入框下边界之后", async () => {
    const instance = render(
      <InputBox disabled={false} terminalWidth={90} onSubmit={() => {}} />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("/age");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const lines = (instance.lastFrame() ?? "").split("\n");
    const inputLine = lines.findIndex((line) => line.includes("❯ /age"));
    const suggestionLine = lines.findIndex((line) => line.includes("/agents"));
    const dividerLines = lines.flatMap((line, index) =>
      /^─+$/.test(line.trim()) ? [index] : []
    );
    expect(inputLine).toBeGreaterThanOrEqual(0);
    expect(suggestionLine).toBeGreaterThan(inputLine);
    expect(dividerLines).toHaveLength(1);
    expect(suggestionLine).toBeGreaterThan(dividerLines[0]!);
  });

  test("Slash 候选用上下键滚动完整命令列表", async () => {
    const instance = render(
      <InputBox disabled={false} terminalWidth={100} onSubmit={() => {}} />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("/");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const initial = instance.lastFrame() ?? "";
    expect(initial).toContain("❯ /help");
    expect(initial).toContain("/model");
    expect(initial).toContain("/plan");
    expect(initial).not.toContain("/agents");
    expect(initial).not.toContain("/tasks");
    expect(initial).toContain("↑/↓ 选择 · Tab 补全");

    const tasksIndex = getSlashCommandSuggestions("/")
      .findIndex((suggestion) => suggestion.name === "tasks");
    expect(tasksIndex).toBeGreaterThan(0);
    for (let index = 0; index < tasksIndex; index += 1) {
      instance.stdin.write("\u001B[B");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const scrolled = instance.lastFrame() ?? "";
    expect(scrolled).not.toContain("/help");
    expect(scrolled).toContain("❯ /tasks");
    expect(scrolled).toContain(`/ ${getSlashCommandSuggestions("/").length}`);
  });

  test("Up/Down 浏览已提交输入并恢复当前草稿", async () => {
    const submitted: string[] = [];
    const instance = render(
      <InputBox
        disabled={false}
        terminalWidth={60}
        onSubmit={(value) => submitted.push(value)}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    instance.stdin.write("第一次提问");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("第二次提问");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("尚未提交的草稿");
    await new Promise((resolve) => setTimeout(resolve, 10));

    instance.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("第二次提问");
    instance.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("第一次提问");
    instance.stdin.write("\u001B[B");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("第二次提问");
    instance.stdin.write("\u001B[B");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("尚未提交的草稿");
    expect(submitted).toEqual(["第一次提问", "第二次提问"]);
  });

  test("多行输入先做垂直移动，到达顶部后才进入历史", async () => {
    const instance = render(
      <InputBox disabled={false} terminalWidth={60} onSubmit={() => {}} />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("历史问题");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("草稿第一行\n草稿第二行");
    await new Promise((resolve) => setTimeout(resolve, 10));

    instance.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("草稿第一行");
    expect(instance.lastFrame()).toContain("草稿第二行");

    instance.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("历史问题");
    expect(instance.lastFrame()).not.toContain("草稿第二行");
  });

  test("重新挂载同一 Session 时恢复历史，新 Session 保持隔离", async () => {
    const persisted = new Map<string, string[]>();
    const store: InputHistoryStore = {
      async load(_cwd, sessionId) {
        return [...(persisted.get(sessionId) ?? [])];
      },
      async append(_cwd, sessionId, input) {
        persisted.set(sessionId, [...(persisted.get(sessionId) ?? []), input]);
      },
    };
    const TestInputBox = createInputBox({ persistentHistory: store });
    const first = render(
      <TestInputBox
        disabled={false}
        terminalWidth={60}
        cwd="/project-a"
        sessionId="session-a"
        onSubmit={() => {}}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.stdin.write("重启后仍存在的问题");
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.unmount();

    const second = render(
      <TestInputBox
        disabled={false}
        terminalWidth={60}
        cwd="/project-a"
        sessionId="session-a"
        onSubmit={() => {}}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(second.lastFrame()).toContain("重启后仍存在的问题");
    second.unmount();

    const newSession = render(
      <TestInputBox
        disabled={false}
        terminalWidth={60}
        cwd="/project-a"
        sessionId="session-b"
        onSubmit={() => {}}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    newSession.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(newSession.lastFrame()).not.toContain("重启后仍存在的问题");
  });

  test("输入历史只保存完整原文，召回长输入时重新生成 Capsule", async () => {
    const persisted: string[] = [];
    const submitted: string[] = [];
    const content = "第一行\n第二行\n第三行\n第四行";
    const store: InputHistoryStore = {
      async load() {
        return [...persisted];
      },
      async append(_cwd, _sessionId, input) {
        persisted.push(input);
      },
    };
    const TestInputBox = createInputBox({ persistentHistory: store });
    const instance = render(
      <TestInputBox
        disabled={false}
        terminalWidth={80}
        cwd="/project"
        sessionId="session"
        onSubmit={(value) => submitted.push(value)}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    instance.stdin.write(content);
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persisted).toEqual([content]);

    instance.stdin.write("\u001B[A");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.lastFrame()).toContain("[Pasted text #1 +3 lines]");
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submitted).toEqual([content, content]);
    expect(persisted).toEqual([content]);
  });
});
