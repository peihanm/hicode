import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import stringWidth from "string-width";
import { reduceThreads } from "../../src/ui/conversation/threadReducer.js";
import type { UIThread } from "../../src/ui/conversation/types.js";
import {
  MessageList,
  StaticMessageList,
} from "../../src/ui/conversation/MessageList.js";
import {layoutUserMessageRows} from "../../src/ui/conversation/projection.js";
import { AppForTest as App } from "../helpers/AppForTest.js";
import type { AgentRunner } from "../../src/agent/index.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestRuntimeResources } from "../helpers/runtimeResources.js";

afterEach(() => cleanup());

describe("subagent UI", () => {
  test("长中文用户消息不会留下只有一两个词的孤立尾行", () => {
    const prompt = "我想做一个能让我自己刷leetcode的网站，你能帮我做一个嘛，我希望能把服务起来，然后在本地web页面上写题目，然后跑程序。题目可以就一道先，主要是把整体框架搭起";
    const rows = layoutUserMessageRows(prompt, 150);

    expect(rows).toHaveLength(2);
    expect(stringWidth(rows.at(-1)!.text)).toBeGreaterThanOrEqual(12);

    expect(rows.map((row) => row.text).join("")).toBe(prompt);
    expect(rows.at(-1)!.text).not.toBe("搭起");
    expect(rows.at(-1)!.text).toEndWith("搭起");
  });

  test("生命周期更新同一个 Agent tool thread，不展开内部工具噪音", () => {
    let threads: UIThread[] = [];
    threads = reduceThreads(threads, {
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "agent-call",
      name: "agent",
      args: JSON.stringify({
        description: "调查 Session",
        prompt: "调查 Session",
        subagent_type: "Explore",
      }),
    });
    threads = reduceThreads(threads, {
      type: "subagent_start",
      agentId: "child-1",
      agentType: "Explore",
      description: "调查 Session",
      parentToolCallId: "agent-call",
    });
    threads = reduceThreads(threads, {
      type: "subagent_end",
      agentId: "child-1",
      agentType: "Explore",
      reason: "completed",
      iterations: 3,
      toolUseCount: 5,
      durationMs: 25,
      report: "完整 Explore 调查报告",
    });
    threads = reduceThreads(threads, {
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "agent-call",
      result: "完整 Explore 调查报告",
      outcome: "ok",
    });

    expect(threads).toHaveLength(1);
    const instance = render(<MessageList threads={threads} />);
    expect(instance.lastFrame()).toContain("Explore Agent · 调查 Session");
    expect(instance.lastFrame()).toContain("Done (5 tool calls · 3 iterations");
    expect(instance.lastFrame()).not.toContain("完整 Explore 调查报告");

    const expanded = render(
      <MessageList threads={threads} transcript />
    );
    expect(expanded.lastFrame()).toContain("Explore response");
    expect(expanded.lastFrame()).toContain("完整 Explore 调查报告");
  });

  test("运行中 Agent 只有底部状态动画，标题不使用静态假 spinner 或重复描述", async () => {
    await withTempProject(async (cwd) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      const runAgentImpl: AgentRunner = async (_input, _history, onEvent) => {
        onEvent({
          type: "tool_call_start",
          turnId: "turn-1",
          toolCallId: "review-running",
          name: "agent",
          args: JSON.stringify({
            description: "独立审查本轮实现",
            subagent_type: "project-reviewer",
          }),
        });
        onEvent({
          type: "subagent_start",
          agentId: "reviewer-running",
          agentType: "project-reviewer",
          description: "独立审查本轮实现",
          parentToolCallId: "review-running",
        });
        started();
        await released;
        onEvent({
          type: "subagent_end",
          agentId: "reviewer-running",
          agentType: "project-reviewer",
          reason: "completed",
          iterations: 1,
          toolUseCount: 0,
          durationMs: 10,
          report: "审查完成",
        });
        onEvent({
          type: "tool_call_end",
          turnId: "turn-1",
          toolCallId: "review-running",
          result: "审查完成",
          outcome: "ok",
        });
        return { reply: "完成", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("验证");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didStart;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("● project-reviewer Agent · 独立审查本轮实现");
      expect(frame).toContain("正在运行 project-reviewer Agent...");
      expect(frame).not.toContain("✻ project-reviewer Agent");
      expect(frame).not.toContain("project-reviewer: 独立审查本轮实现");

      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  });

  test("App 中 Ctrl+O 切换 Explore response", async () => {
    await withTempProject(async (cwd) => {
      const runAgentImpl: AgentRunner = async (
        _input,
        _history,
        onEvent
      ) => {
        onEvent({
          type: "tool_call_start",
          turnId: "turn-1",
          toolCallId: "agent-call",
          name: "agent",
          args: JSON.stringify({
            description: "调查 Session",
            prompt: "调查 Session",
            subagent_type: "Explore",
          }),
        });
        onEvent({
          type: "subagent_start",
          agentId: "child-1",
          agentType: "Explore",
          description: "调查 Session",
          parentToolCallId: "agent-call",
        });
        onEvent({
          type: "subagent_end",
          agentId: "child-1",
          agentType: "Explore",
          reason: "completed",
          iterations: 2,
          toolUseCount: 4,
          durationMs: 1200,
          report: "可展开的 Explore 报告",
        });
        onEvent({
          type: "tool_call_end",
          turnId: "turn-1",
          toolCallId: "agent-call",
          result: "可展开的 Explore 报告",
          outcome: "ok",
        });
        return { reply: "完成", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("调查");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(instance.lastFrame()).toContain("Done (4 tool calls · 2 iterations");
      expect(instance.lastFrame()).not.toContain("可展开的 Explore 报告");

      instance.stdin.write("\x0f");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("可展开的 Explore 报告");
    });
  });

  test("运行中 Ctrl+O 使用单一 Transcript，并按根工具到子 Agent 排序", async () => {
    await withTempProject(async (cwd) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      const runAgentImpl: AgentRunner = async (_input, _history, onEvent) => {
        onEvent({
          type: "tool_call_start",
          turnId: "turn-1",
          toolCallId: "root-list",
          name: "list_files",
          args: JSON.stringify({ dir: "." }),
        });
        onEvent({
          type: "tool_call_end",
          turnId: "turn-1",
          toolCallId: "root-list",
          result: "data/\npublic/\nserver.js",
          outcome: "ok",
        });
        onEvent({
          type: "tool_call_start",
          turnId: "turn-1",
          toolCallId: "agent-call",
          name: "agent",
          args: JSON.stringify({
            description: "调查刷题网站项目现状",
            subagent_type: "Explore",
          }),
        });
        onEvent({
          type: "subagent_start",
          agentId: "child-running",
          agentType: "Explore",
          description: "调查刷题网站项目现状",
          parentToolCallId: "agent-call",
        });
        onEvent({
          type: "subagent_progress",
          agentId: "child-running",
          event: {
            type: "tool_start",
            toolCallId: "child-list",
            name: "list_files",
            args: JSON.stringify({ dir: "." }),
          },
        });
        started();
        await released;
        onEvent({
          type: "subagent_end",
          agentId: "child-running",
          agentType: "Explore",
          reason: "completed",
          iterations: 1,
          toolUseCount: 1,
          durationMs: 10,
          report: "调查完成",
        });
        onEvent({
          type: "tool_call_end",
          turnId: "turn-1",
          toolCallId: "agent-call",
          result: "调查完成",
          outcome: "ok",
        });
        return { reply: "完成", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("调查");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didStart;
      await new Promise((resolve) => setTimeout(resolve, 20));

      try {
        instance.stdin.write("\x0f");
        await new Promise((resolve) => setTimeout(resolve, 30));
        const frame = instance.lastFrame() ?? "";
        expect(frame.match(/● Explore Agent/g) ?? []).toHaveLength(1);
        const transcriptIndex = frame.indexOf("Transcript · Ctrl+O to close");
        const rootListIndex = frame.indexOf("● List .", transcriptIndex);
        const agentIndex = frame.indexOf(
          "● Explore Agent · 调查刷题网站项目现状",
          transcriptIndex
        );
        expect(transcriptIndex).toBeGreaterThanOrEqual(0);
        expect(rootListIndex).toBeGreaterThan(transcriptIndex);
        expect(agentIndex).toBeGreaterThan(rootListIndex);
      } finally {
        release();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    });
  });

  test.each([
    ["completed", "Done"],
    ["interrupted", "Stopped"],
  ] as const)("自定义审查报告按运行状态 %s 展示，正文不变成验收判定", (reason, label) => {
    let threads: UIThread[] = reduceThreads([], {
      type: "tool_call_start", turnId: "turn-1", toolCallId: "review-call", name: "agent",
      args: JSON.stringify({description: "检查数据竞争", subagent_type: "project-reviewer"}),
    });
    threads = reduceThreads(threads, {
      type: "subagent_start", agentId: "review-1", agentType: "project-reviewer",
      description: "检查数据竞争", parentToolCallId: "review-call",
    });
    threads = reduceThreads(threads, {
      type: "subagent_end", agentId: "review-1", agentType: "project-reviewer", reason,
      iterations: 4, toolUseCount: 5, durationMs: 1_000,
      report: "发现并发写入风险，见 store.ts:20。\nVERDICT: FAIL",
    });
    const frame = render(<MessageList threads={threads} />).lastFrame() ?? "";
    expect(frame).toContain(`${label} (5 tool calls · 4 iterations · 1s)`);
    expect(frame).not.toContain("Issue found");
    expect(frame).not.toContain("Verified");
    const expanded = render(<MessageList threads={threads} transcript />).lastFrame() ?? "";
    expect(expanded).toContain("project-reviewer response");
    expect(expanded).toContain("发现并发写入风险，见 store.ts:20。");
    expect(expanded).toContain("VERDICT: FAIL");
  });

  test("已知长 Bash 默认使用阶段摘要，Transcript 保留可见换行和截断", () => {
    const command = [
      'echo "=== first ==="',
      "curl -s http://localhost:3000/api/first",
      "curl -s http://localhost:3000/api/second",
      "x".repeat(240),
    ].join("\n");
    const threads = reduceThreads([], {
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "long-bash",
      name: "bash",
      args: JSON.stringify({ command }),
    });

    const frame = render(<MessageList threads={threads} />).lastFrame() ?? "";
    expect(frame).toContain("● Verifying");
    expect(frame).toContain("… Checking local endpoints");
    expect(frame).not.toContain("curl -s");
    expect(frame).not.toContain("x".repeat(200));

    const transcript = render(
      <MessageList threads={threads} transcript />
    ).lastFrame() ?? "";
    expect(transcript).toContain('Bash echo "=== first ===" ⏎ curl -s');
    expect(transcript).toContain("…");
    expect(transcript).not.toContain("x".repeat(200));
  });

  test("read_file 结果只展示读取范围，不泄露模型协议头", () => {
    let threads = reduceThreads([], {
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "read-readme",
      name: "read_file",
      args: JSON.stringify({ path: "/project/README.md" }),
    });
    threads = reduceThreads(threads, {
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "read-readme",
      result: [
        "文件: /project/README.md",
        "行范围: 1-60 / 60",
        "注意: 左侧行号不是文件内容，edit_file.old_string 不要包含这些行号。",
        "",
        "     1\t# README",
      ].join("\n"),
      outcome: "ok",
    });

    const frame = render(<MessageList threads={threads} />).lastFrame() ?? "";
    expect(frame).toContain("● Inspecting project");
    expect(frame).toContain("✓ Read /project/README.md · 60 lines");
    expect(frame).not.toContain("左侧行号不是文件内容");

    const transcript = render(
      <MessageList threads={threads} transcript />
    ).lastFrame() ?? "";
    expect(transcript).toContain("Read /project/README.md");
    expect(transcript).toContain("行范围: 1-60 / 60");
    expect(transcript).toContain("左侧行号不是文件内容");
  });

  test("Assistant 常用 Markdown 转为终端层级且标记间距稳定", () => {
    const threads: UIThread[] = [{
      id: "markdown-answer",
      role: "assistant",
      text: [
        "## 完成",
        "",
        "服务地址：**http://localhost:3000**",
        "",
        "### 题目",
        "| 题目 | 难度 |",
        "|---|---|",
        "| 两数之和 | Easy |",
        "",
        "- 使用 `bash_task` 管理服务",
      ].join("\n"),
    }];

    const frame = render(
      <MessageList threads={threads} terminalWidth={90} />
    ).lastFrame() ?? "";
    expect(frame).toContain("● 完成");
    expect(frame).toContain("服务地址：http://localhost:3000");
    expect(frame).toContain("题目");
    expect(frame).toContain("两数之和");
    expect(frame).toContain("• 使用 bash_task 管理服务");
    expect(frame).not.toContain("##");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("|---|");
  });

  test("Assistant 正文不绘制会被终端二次折行穿透的竖轨，并折叠多余空行", () => {
    const text = [
      "框架之前已经搭好了。",
      "",
      "",
      "",
      "使用方式：打开浏览器访问 http://127.0.0.1:8400，在编辑器里写 Solution.twoSum，点击运行。",
      "",
      "",
    ].join("\n");
    const frame = render(
      <MessageList
        threads={[{id: "assistant-reflow", role: "assistant", text}]}
        terminalWidth={48}
      />
    ).lastFrame() ?? "";

    expect(frame).toContain("● 框架之前已经搭好了。");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("\n\n\n");
    expect(frame.trimEnd()).toEndWith("点击运行。");
    expect(frame.split("\n").every((line) => stringWidth(line) <= 48)).toBe(true);
  });

  test("Static fallback 按当前终端宽度排版 Assistant", () => {
    const paragraph = "使用方式：打开浏览器访问 http://127.0.0.1:8400，在编辑器里写 Solution.twoSum，点「运行」（或 ⌘+Enter）即在本地子进程执行并展示每个用例的输入/输出/预期。";
    const frame = render(
      <StaticMessageList
        threads={[{id: "assistant-static-reflow", role: "assistant", text: paragraph}]}
        terminalWidth={40}
      />
    ).lastFrame() ?? "";

    expect(frame).toContain("● 使用方式：打开浏览器访问");
    expect(frame.trim().split("\n").length).toBeGreaterThan(1);
    expect(frame.split("\n").every((line) => stringWidth(line) <= 40)).toBe(true);
  });
});
