import {afterEach, expect, test} from "bun:test";
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

afterEach(cleanup);
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));}
  throw new Error("UI did not settle");
}

test("任务面板区分层级，停止任务不提示停止，窄屏中文标题不溢出", async () => {
  await withTempProject(async cwd => {
    const runtime = createTaskRuntimeForTest(cwd, {sandboxStatus: {kind: "disabled"}, async run() {
      return {stdout: "", stderr: "", termination: {kind: "aborted", reason: "shutdown"}, outputBytes: 0, outputComplete: true};
    }});
    const ctx = createTestContext(cwd);
    const tasks = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
    await tasks.startShell({command: "python3 -m http.server 8000 --bind 127.0.0.1 中文测试 👨‍👩‍👧‍👦", cwd, toolCallId: "visual"});
    const instance = render(<TasksDialog tasks={tasks} stopTask={async () => {throw new Error("已结束任务不应停止");}} onClose={() => {}}/>);
    let columns = 100;
    Object.defineProperty(instance.stdout, "columns", {configurable: true, get: () => columns});
    try {
      await until(() => instance.lastFrame()?.includes("最近结束") === true);
      for (const width of [100, 40, 24]) {
        columns = width; instance.stdout.emit("resize");
        await new Promise(resolve => setTimeout(resolve, 90));
        const frame = instance.lastFrame() ?? "";
        expect(frame).toContain("◆ 后台任务");
        expect(frame).toContain("1 / 1");
        expect(frame).toContain("○ 已停止");
        expect(frame).not.toContain("s 停止");
        expect(frame).not.toContain("│");
        expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      }
      instance.stdin.write("\r"); await until(() => instance.lastFrame()?.includes("◆ 任务输出") === true);
      expect(instance.lastFrame()).toContain("暂无输出");
      expect(instance.lastFrame()).not.toContain("s 停止");
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
      await until(() => instance.lastFrame()?.includes("暂无后台任务") === true);
      expect(instance.lastFrame()).toContain("0 项");
      expect(instance.lastFrame()).not.toContain("Enter 查看输出");
      expect(instance.lastFrame()).not.toContain("s 停止");
    } finally {instance.unmount(); await resources.close();}
  });
});
for (const denied of [false, true]) {
  test(`/tasks 列表、输出和停止使用统一工具链（deny=${denied}）`, async () => {
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
        await new Promise(resolve => setTimeout(resolve, 40));
        instance.stdin.write("/tasks"); await new Promise(resolve => setTimeout(resolve, 20)); instance.stdin.write("\r");
        await until(() => instance.lastFrame()?.includes("Enter 查看输出") === true);
        expect(instance.lastFrame()).toContain("printf ready; sleep 30");
        const newer = await rootSession.taskSession.startShell({command: "sleep 31", cwd, toolCallId: "newer"});
        await until(() => instance.lastFrame()?.includes("sleep 31") === true);
        expect(instance.lastFrame()).toContain("❯ printf ready");
        instance.stdin.write("\r"); await until(() => instance.lastFrame()?.includes("当前输出预览") === true);
        expect(instance.lastFrame()).toContain("ready");
        instance.stdin.write("s"); await until(() => calls.includes("task"));
        if (denied) {
          await new Promise(resolve => setTimeout(resolve, 60));
          expect((await rootSession.taskSession.get(task.id))?.status).toBe("running");
          expect(instance.lastFrame()).toContain("Error:");
        } else {
          await until(async () => (await rootSession.taskSession.get(task.id))?.status === "cancelled");
          await until(() => instance.lastFrame()?.includes("已停止") === true);
        }
        expect((await rootSession.taskSession.get(newer.id))?.status).toBe("running");
        instance.stdin.write("\u001b"); await new Promise(resolve => setTimeout(resolve, 20));
        instance.stdin.write("\u001b"); await until(() => instance.lastFrame()?.includes("Ask Pillar") === true);
      } finally {instance.unmount(); await resources.close();}
    });
  });
}
