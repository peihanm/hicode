import {afterEach, expect, test, setSystemTime} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {App} from "../../src/ui/App.js";
import {createUITurnSessionRuntime} from "../../src/ui/turn/sessionRuntime.js";
import {createTestRuntimeResources, createTestSettings} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {ToolRuntime} from "../../src/tools/runtime.js";
import {TasksDialog} from "../../src/ui/tasks/TasksDialog.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import stringWidth from "string-width";
import {Text, Box} from "ink";
import {layoutTerminalMarkdown} from "../../src/ui/conversation/TerminalMarkdown.js";

afterEach(cleanup);
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));}
  throw new Error("UI did not settle");
}

test("task report Markdown retains content and styles across wrapped viewport rows", () => {
  const lines = layoutTerminalMarkdown("## Final report\n**Implemented** `src/ui.ts`\n\n- 中文路径和 👨‍👩‍👧‍👦 内容\n```ts\nconst result = 123;\n```", 20);
  const view = render(<Box flexDirection="column" width={20}>{lines.map((line, index) => <Text key={index}>{line}</Text>)}</Box>);
  const frame = view.lastFrame()!;
  expect(frame).toContain("Final report");
  expect(frame).toContain("Implemented");
  expect(frame).toContain("const result = 123;");
  expect(frame).not.toContain("##");
  expect(frame).not.toContain("**");
  expect(frame).not.toContain("```ts");
  expect(frame.split("\n").every(line => stringWidth(line) <= 20)).toBe(true);
  view.unmount();
});

test("Agent detail uses terminal height, scrolls, preserves selection and returns through one Esc per level", async () => {
  await withTempProject(async cwd => {
    const ctx = createTestContext(cwd);
    const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, (options, request) => ({agentId: options.agentId, async run() {
      return {agentId: options.agentId, agentType: request.agentType, description: request.description, reason: "completed",
        reply: "## Final report\n**Implemented** src/ui.ts\n" + Array.from({length: 70}, (_, index) => `Line ${index}`).join("\n"),
        iterations: 13, toolUseCount: 22, durationMs: 1};
    }}));
    const tasks = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
    let closed = 0;
    const task = await tasks.startAgent({request: {agentType: "Worker", name: "board", description: "Board implementation", prompt: "work", parentToolCallId: "spawn"}, parentContext: ctx});
    await until(async () => (await tasks.get(task.id))?.status === "completed");
    const view = render(<TasksDialog tasks={tasks} stopTask={async () => {}} onClose={() => {closed++;}}/>);
    let columns = 110, height = 40;
    Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
    Object.defineProperty(view.stdout, "rows", {configurable: true, get: () => height});
    view.stdout.emit("resize");
    try {
      await until(() => view.lastFrame()?.includes("Board implementation") === true);
      view.stdin.write("\r");
      await until(() => view.lastFrame()?.includes("Final report") === true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(view.lastFrame()).toContain("Line 15");
      expect(view.lastFrame()).not.toContain("13 rounds");
      expect(view.lastFrame()).not.toContain("**Implemented**");
      for (let i = 0; i < 5; i++) {view.stdin.write("\u001b[B"); await new Promise(resolve => setTimeout(resolve, 10));}
      expect(view.lastFrame()).not.toContain("Final report");
      view.stdin.write("r"); await new Promise(resolve => setTimeout(resolve, 30));
      expect(view.lastFrame()).not.toContain("Final report");
      columns = 50; height = 24; view.stdout.emit("resize");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(view.lastFrame()).not.toContain("Final report");
      expect(view.lastFrame()!.split("\n").every(line => stringWidth(line) <= columns)).toBe(true);
      expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(height);
      view.stdin.write("\u001b"); await until(() => !view.lastFrame()?.includes("◆ Task output"));
      expect(closed).toBe(0);
      expect(view.lastFrame()).toContain("❯ Board implementation");
      view.stdin.write("\u001b"); await until(() => closed === 1);
    } finally {view.unmount(); await runtime.close();}
  });
});

test("任务面板区分层级，停止任务不提示停止，窄屏中文标题不溢出", async () => {
  await withTempProject(async cwd => {
    const runtime = createTaskRuntimeForTest(cwd, {sandboxStatus: {kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}, async run() {
      return {stdout: "", stderr: "", termination: {kind: "aborted", reason: "shutdown"}, outputBytes: 0, outputComplete: true};
    }});
    const ctx = createTestContext(cwd);
    const tasks = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
    await tasks.startShell({command: "python3 -m http.server 8000 --bind 127.0.0.1 中文测试 👨‍👩‍👧‍👦", cwd, toolCallId: "visual"});
    const instance = render(<TasksDialog tasks={tasks} stopTask={async () => {throw new Error("已结束任务不应停止");}} onClose={() => {}}/>);
    let columns = 100;
    Object.defineProperty(instance.stdout, "columns", {configurable: true, get: () => columns});
    try {
      await until(() => instance.lastFrame()?.includes("0 running · 1 finished") === true);
      for (const width of [100, 40, 24]) {
        columns = width; instance.stdout.emit("resize");
        await new Promise(resolve => setTimeout(resolve, 90));
        const frame = instance.lastFrame() ?? "";
        expect(frame).toContain("◆ Tasks");
        expect(frame).toContain("1 / 1");
        expect(frame).toContain("○ Stopped");
        expect(frame).not.toContain("s stop");
        expect(frame).not.toContain("│");
        expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      }
      instance.stdin.write("\r"); await until(() => instance.lastFrame()?.includes("◆ Task output") === true);
      expect(instance.lastFrame()).toContain("No output yet");
      expect(instance.lastFrame()).not.toContain("s stop");
      expect((instance.lastFrame() ?? "").split("\n").every(line => stringWidth(line) <= columns)).toBe(true);
    } finally {instance.unmount(); await runtime.close();}
  });
});

test("空任务面板有独立空状态，不展示无效操作", async () => {
  await withTempProject(async cwd => {
    const resources = createTestRuntimeResources(cwd);
    const {rootSession} = createUITurnSessionRuntime(resources);
    const instance = render(<TasksDialog tasks={rootSession.taskSession} stopTask={async () => {}} onClose={() => {}}/>);
    try {
      await until(() => instance.lastFrame()?.includes("No background tasks") === true);
      expect(instance.lastFrame()).toContain("0 tasks");
      expect(instance.lastFrame()).not.toContain("Enter view output");
      expect(instance.lastFrame()).not.toContain("s stop");
    } finally {instance.unmount(); await resources.close();}
  });
});
for (const denied of [false, true]) {
  test(`/tasks 列表、输出和停止使用统一工具链（deny=${denied})`, async () => {
    await withTempProject(async cwd => {
      const settings = createTestSettings();
      if (denied) settings.permissions.rules.deny.push({toolName: "task", source: "project"});
      const resources = createTestRuntimeResources(cwd, {settings});
      const calls: string[] = [];
      const base = resources.toolRuntime;
      const toolRuntime: ToolRuntime = {...base, async executeTool(...args) {calls.push(args[0]); return base.executeTool(...args);}};
      const configured = {...resources, toolRuntime};
      const {rootSession} = createUITurnSessionRuntime(configured);
      await rootSession.initialize();
      const task = await rootSession.taskSession.startShell({command: "printf ready;\nsleep 30", cwd, toolCallId: "fixture"});
      const instance = render(<App resources={configured} rootSession={rootSession}/>);
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        instance.stdin.write("/tasks"); await new Promise(resolve => setTimeout(resolve, 20)); instance.stdin.write("\r");
        await until(() => instance.lastFrame()?.includes("Enter view output") === true);
        expect(instance.lastFrame()).toContain("printf ready; sleep 30");
        const newer = await rootSession.taskSession.startShell({command: "sleep 31", cwd, toolCallId: "newer"});
        await until(() => instance.lastFrame()?.includes("sleep 31") === true);
        expect(instance.lastFrame()).toContain("❯ printf ready");
        instance.stdin.write("\r"); await until(() => instance.lastFrame()?.includes(" lines") === true);
        expect(instance.lastFrame()).toContain("ready");
        instance.stdin.write("s"); await until(() => calls.includes("task"));
        if (denied) {
          await new Promise(resolve => setTimeout(resolve, 60));
          expect((await rootSession.taskSession.get(task.id))?.status).toBe("running");
          expect(instance.lastFrame()).toContain("Error:");
        } else {
          await until(async () => (await rootSession.taskSession.get(task.id))?.status === "cancelled");
          await until(() => instance.lastFrame()?.includes("Stopped") === true);
        }
        expect((await rootSession.taskSession.get(newer.id))?.status).toBe("running");
        instance.stdin.write("\u001b"); await new Promise(resolve => setTimeout(resolve, 20));
        instance.stdin.write("\u001b"); await until(() => instance.lastFrame()?.includes("Ask HiCode") === true);
      } finally {instance.unmount(); await resources.close();}
    });
  });
}

test("followup displays the current run duration and excludes idle time from the detail total", async () => {
  await withTempProject(async cwd => {
    const ctx = createTestContext(cwd);
    const base = Date.parse("2026-09-19T00:00:00.000Z");
    let run = 0;
    const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, options => ({agentId: options.agentId, async run() {
      run++;
      setSystemTime(new Date(base + (run === 1 ? 10000 : 130000)));
      return {agentId: options.agentId, agentType: "Worker", description: "Board", reply: "Verified", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 0};
    }}));
    const tasks = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
    try {
      setSystemTime(new Date(base));
      const task = await tasks.startAgent({request: {agentType: "Worker", name: "board", description: "Board", prompt: "work", parentToolCallId: "spawn"}, parentContext: ctx});
      await until(async () => (await tasks.get(task.id))?.status === "completed");
      setSystemTime(new Date(base + 110000));
      await tasks.followup(task.id, "next");
      await until(async () => (await tasks.get(task.id))?.status === "completed");
      const view = render(<TasksDialog tasks={tasks} stopTask={async () => {}} onClose={() => {}}/>);
      try {
        await until(() => view.lastFrame()?.includes("Run 2 · 20s") === true);
        view.stdin.write("\r");
        await until(() => view.lastFrame()?.includes("Total execution: 30s") === true);
        expect(view.lastFrame()).toContain("Todos this run: not updated");
        expect(view.lastFrame()).not.toContain("2m 10s");
        for (const width of [50, 30]) {
          Object.defineProperty(view.stdout, "columns", {configurable: true, value: width});
          view.stdout.emit("resize");
          await new Promise(resolve => setTimeout(resolve, 100));
          expect(view.lastFrame()!.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
        }
      } finally {view.unmount();}
    } finally {await runtime.close(); setSystemTime();}
  });
});
