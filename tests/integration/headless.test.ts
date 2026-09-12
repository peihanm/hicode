import {fixtureToolSchemas} from "../helpers/fakeLLM.js";
import { describe, expect, test } from "bun:test";
import { formatHeadlessOutput } from "../../src/headless/output.js";
import type {HeadlessRunSummary} from "../../src/headless/types.js";
import { assistantText, assistantToolCall, createFakeLLM } from "../helpers/fakeLLM.js";
import { withTempProject } from "../helpers/tempProject.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  abortableDelay,
  createTurnAbortController,
} from "../../src/runtime/abort.js";
import {
  createTestRuntimeResources,
  createTestSettings,
} from "../helpers/runtimeResources.js";
import type { AgentRunner } from "../../src/agent/index.js";
import {
  type HeadlessTestInput,
  runHeadlessForTest as runHeadless,
} from "../helpers/headless.js";
import { createSubagentRegistry } from "../../src/subagents/index.js";
import type {HookRuntime} from "../../src/hooks/index.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";

function toolItems(result: HeadlessRunSummary) {return result.items.filter(item => item.type === "tool_call");}
function agentItems(result: HeadlessRunSummary) {return result.items.filter(item => item.type === "subagent");}
function fileChanges(result: HeadlessRunSummary) {return result.items.flatMap(item => item.type === "file_change" ? item.changes : []);}

function options(cwd: string): HeadlessTestInput {
  return {
    cwd,
    settings: createTestSettings(),
    prompt: "执行任务",
    permissionMode: "full-access",
        collaborationMode: "build",
    resumeMode: { kind: "none" },
    outputFormat: "json",
  };
}

const ignoreOutput = async () => {};

describe("headless integration", () => {
  test("Session 构造失败仍关闭已经创建的 Root resources", async () => {
    await withTempProject(async (cwd) => {
      let closeCount = 0;
      const resources = createTestRuntimeResources(cwd, {
        async close() {
          closeCount += 1;
        },
      });
      resources.toolRuntime.restoreToolDiscovery = () => {
        throw new Error("session construction failed");
      };

      await expect(runHeadless(options(cwd), {
        createResources: async () => resources,
        writeOutput: ignoreOutput,
      })).rejects.toThrow("session construction failed");
      expect(closeCount).toBe(1);
    });
  });

  test("Session 存储无法创建时不运行 Agent", async () => {
    await withTempProject(async (cwd) => {
      const pillarHome = join(cwd, "blocked-storage");
      await writeFile(pillarHome, "not a directory");
      const storage = createPillarStorageLayout({pillarHome});
      const settings = createTestSettings({
        });
      const resources = createTestRuntimeResources(cwd, {settings});
      (resources as {storage: typeof storage}).storage = storage;
      let agentCalls = 0;

      await expect(runHeadless({
        ...options(cwd),
        settings,
        storage,
      }, {
        createResources: async () => resources,
        runAgent: (async () => {
          agentCalls += 1;
          return {reply: "unexpected", reason: "completed", iterations: 1};
        }) as AgentRunner,
        writeOutput: ignoreOutput,
        writeDiagnostic: async () => {},
      })).rejects.toThrow();
      expect(agentCalls).toBe(0);
    });
  });

  test("输出写入失败仍关闭本轮 Root resources", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([assistantText("completed")]);
      await expect(
        runHeadless(options(cwd), {
          mcpManager: false,
          agent: { callLLM: fake.callLLM },
          writeOutput: async () => {
            throw new Error("stdout failed");
          },
        })
      ).rejects.toThrow("stdout failed");
    });
  });

  test("正常完成返回 exit 0，并输出可解析 JSON", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([assistantText("completed")]);
      let captured: HeadlessRunSummary | undefined;
      const summary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: { callLLM: fake.callLLM },
        writeOutput(value) {
          captured = value;
        },
      });

      expect(summary).toMatchObject({ ok: true, exitCode: 0, finalResponse: "completed" });
      expect(captured).toBe(summary);
      expect(JSON.parse(formatHeadlessOutput(summary, "json"))).toMatchObject({
        ok: true,
        exitCode: 0,
        stopReason: "completed",
      });
    });
  });

  test("执行 Session/User/End Hooks，并把 prompt block 映射为 exit 2", async () => {
    await withTempProject(async (cwd) => {
      const events: string[] = [];
      const hooks: HookRuntime = {
        enabled: true, hasToolHooks: () => true, inspect: () => [], reload: async () => {},
        issues: [],
        async execute(input) {
          events.push(input.hook_event_name);
          return input.hook_event_name === "UserPromptSubmit"
            ? {
                blocked: true,
                blockReason: "headless policy",
                additionalContexts: [],
                executions: [],
              }
            : {
                blocked: false,
                additionalContexts: [],
                executions: [],
              };
        },
      };
      let agentCalls = 0;
      const resources = createTestRuntimeResources(cwd, {hooks});
      const summary = await runHeadless(options(cwd), {
        createResources: async () => resources,
        runAgent: (async () => {
          agentCalls += 1;
          return {reply: "unexpected", reason: "completed", iterations: 1};
        }) as AgentRunner,
        saveSession: async () => {},
        writeOutput: ignoreOutput,
      });

      expect(agentCalls).toBe(0);
      expect(events).toEqual([
        "SessionStart",
        "UserPromptSubmit",
        "TurnEnd",
        "SessionEnd",
      ]);
      expect(summary).toMatchObject({
        ok: false,
        exitCode: 2,
        stopReason: "hook_blocked",
      });
      expect(summary.finalResponse).toContain("headless policy");
    });
  });

  test("同步 Explore 生命周期进入 Headless 结构化摘要", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall(
          "agent",
          {
            description: "调查入口",
            prompt: "调查 CLI 入口并简要报告",
            subagent_type: "Explore",
          },
          "headless-agent"
        ),
        assistantText("入口位于 src/index.tsx"),
        (call) => {
          const result = call.messages.find(
            (message) =>
              message.role === "tool" && message.tool_call_id === "headless-agent"
          );
          expect(result?.content).toContain("入口位于 src/index.tsx");
          return assistantText("调查完成");
        },
      ]);
      const summary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: { callLLM: fake.callLLM },
        toolResultStoreOptions: { pillarHome: join(cwd, "tool-results") },
        writeOutput: ignoreOutput,
      });

      expect(summary.finalResponse).toBe("调查完成");
      expect(agentItems(summary)).toHaveLength(1);
      expect(agentItems(summary)[0]).toMatchObject({
        agentType: "Explore",
        description: "调查入口",
        status: "completed",
        reason: "completed",
        iterations: 1,
        toolUseCount: 0,
      });
      expect(agentItems(summary)[0]?.transcriptPath).toBeTruthy();
      expect(toolItems(summary)[0]).toMatchObject({
        name: "agent",
        outcome: "ok",
      });
    });
  });

  test("工具失败保留原记录，正常结束不额外改退出码", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall("broken", {}, "broken-1"),
        assistantText("工具仍然失败，任务未完成"),
      ]);
      const summary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: {
          callLLM: fake.callLLM,
          getToolSchemas: () => fixtureToolSchemas("broken"),
          executeTool: async () => ({
            modelContent: "Tool execution error: boom",
            displayContent: "Tool execution error: boom",
            outcome: "failed",
          }),
        },
        writeOutput: ignoreOutput,
      });

      expect(summary.ok).toBe(true);
      expect(summary.exitCode).toBe(0);
      expect(toolItems(summary).filter(item => item.outcome === "failed")).toHaveLength(1);
      expect(toolItems(summary)[0]?.outcome).toBe("failed");
      expect(summary.finalResponse).toBe("工具仍然失败，任务未完成");
      expect(fake.calls).toHaveLength(2);
      expect(formatHeadlessOutput(summary, "text")).not.toContain(
        "1 tool call(s) failed"
      );
    });
  });

  test("权限拒绝单独记录，正常结束不额外改退出码", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall("write_file", {}, "denied-1"),
        assistantText("无法写入"),
      ]);
      const summary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: {
          callLLM: fake.callLLM,
          executeTool: async () => ({
            modelContent: "Permission denied: test policy",
            displayContent: "Permission denied: test policy",
            outcome: "denied",
          }),
        },
        writeOutput: ignoreOutput,
      });

      expect(summary.exitCode).toBe(0);
      expect(toolItems(summary).filter(item => item.outcome === "denied")).toHaveLength(1);
      expect(toolItems(summary).filter(item => item.outcome === "failed")).toHaveLength(0);
      expect(toolItems(summary)[0]?.outcome).toBe("denied");
    });
  });

  test("达到 max turns 返回 exit 3", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall("loop", {}, "loop-1"),
        assistantToolCall("loop", {}, "loop-2"),
      ]);
      const summary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: {
          callLLM: fake.callLLM,
          getToolSchemas: () => fixtureToolSchemas("loop"),
          executeTool: async () => "continue",
          maxIterations: 2,
        },
        writeOutput: ignoreOutput,
      });

      expect(summary).toMatchObject({
        ok: false,
        exitCode: 3,
        stopReason: "max_turns",
        iterations: 2,
      });
      expect(formatHeadlessOutput(summary, "text")).toContain(
        "max_turns"
      );
    });
  });

  test("continue 恢复同一 session id", async () => {
    await withTempProject(async (cwd) => {
      const first = createFakeLLM([assistantText("第一轮")]);
      const firstSummary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: { callLLM: first.callLLM },
        writeOutput: ignoreOutput,
      });

      const second = createFakeLLM([assistantText("第二轮")]);
      const secondSummary = await runHeadless(
        { ...options(cwd), resumeMode: { kind: "continue" } },
        {
          mcpManager: false,
          agent: { callLLM: second.callLLM },
          writeOutput: ignoreOutput,
        }
      );

      expect(secondSummary.threadId).toBe(firstSummary.threadId);
      expect(
        second.calls[0]?.messages.some(
          (message) => message.role === "assistant" && message.content === "第一轮"
        )
      ).toBe(true);
    });
  });

  test("大结果引用进入 JSON，continue 后仍可分页读取", async () => {
    await withTempProject(async (cwd) => {
      const pillarHome = join(cwd, "tool-result-root");
      const firstFake = createFakeLLM([
        assistantToolCall(
          "bash",
          { command: "node -e \"process.stdout.write('h'.repeat(40000))\"" },
          "headless-large"
        ),
        assistantText("已保存"),
      ]);
      const first = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: { callLLM: firstFake.callLLM },
        toolResultStoreOptions: { pillarHome },
        writeOutput: ignoreOutput,
      });
      expect(toolItems(first)[0]).toMatchObject({
        resultId: "tr_headless-large",
        resultComplete: true,
      });
      expect(JSON.parse(formatHeadlessOutput(first, "json"))).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({type: "tool_call", resultId: "tr_headless-large"})]),
      });

      const secondFake = createFakeLLM([
        assistantToolCall(
          "read_file",
          { path: toolItems(first)[0]!.resultPath!, limit: 1 },
          "headless-read"
        ),
        (call) => {
          const result = call.messages.find(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === "headless-read"
          );
          expect(result?.content).toContain("h".repeat(20));
          return assistantText("恢复读取成功");
        },
      ]);
      const second = await runHeadless(
        { ...options(cwd), resumeMode: { kind: "continue" } },
        {
          mcpManager: false,
          agent: { callLLM: secondFake.callLLM },
          toolResultStoreOptions: { pillarHome },
          writeOutput: ignoreOutput,
        }
      );
      expect(second.threadId).toBe(first.threadId);
      expect(second.finalResponse).toBe("恢复读取成功");
    });
  });

  test("headless 拒绝交互式 resume picker", async () => {
    await withTempProject(async (cwd) => {
      await expect(
        runHeadless(
          { ...options(cwd), resumeMode: { kind: "picker" } },
          { mcpManager: false, writeOutput: ignoreOutput }
        )
      ).rejects.toThrow("Headless mode cannot use interactive -r");
    });
  });

  test("JSON 摘要包含结构化文件修改，模型结果不包含完整 diff", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall(
          "write_file",
          { path: "created.txt", content: "alpha\nbeta\n" },
          "write-created"
        ),
        (call) => {
          const toolResult = call.messages.find(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === "write-created"
          );
          expect(toolResult?.content).toContain("Wrote created.txt");
          expect(toolResult?.content).not.toContain("+ alpha");
          return assistantText("创建完成");
        },
      ]);
      const summary = await runHeadless(options(cwd), {
        mcpManager: false,
        agent: { callLLM: fake.callLLM },
        writeOutput: ignoreOutput,
      });

      expect(fileChanges(summary)).toHaveLength(1);
      expect(fileChanges(summary)[0]).toMatchObject({
        path: "created.txt",
        kind: "create",
        linesAdded: 2,
        linesRemoved: 0,
      });
      expect(summary.items.some(item => item.type === "file_change")).toBe(true);
      expect(JSON.parse(formatHeadlessOutput(summary, "json"))).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({type: "file_change", changes: [expect.objectContaining({path: "created.txt", linesAdded: 2})]})]),
      });
    });
  });

  test("注入 signal 后返回 interrupted 和 exit 130", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fake = createFakeLLM([
        async (call) => {
          started();
          await abortableDelay(10_000, call.signal!);
          return assistantText("不应到达");
        },
      ]);
      const running = runHeadless(options(cwd), {
        mcpManager: false,
        signal: controller.signal,
        agent: { callLLM: fake.callLLM },
        writeOutput: ignoreOutput,
      });
      await didStart;
      controller.abort("sigint");

      const summary = await running;
      expect(summary).toMatchObject({
        ok: false,
        exitCode: 130,
        stopReason: "interrupted",
        abortReason: "sigint",
      });
      expect(formatHeadlessOutput(summary, "text")).toContain("interrupted");
    });
  });

  test("Agent 普通异常仍关闭 injected Root resources", async () => {
    await withTempProject(async (cwd) => {
      let closeCount = 0;
      const resources = createTestRuntimeResources(cwd, {
        async close() {
          closeCount += 1;
        },
      });
      await expect(
        runHeadless(options(cwd), {
          createResources: async () => resources,
          runAgent: (async () => {
            throw new Error("agent failed");
          }) as AgentRunner,
          writeOutput: ignoreOutput,
        })
      ).rejects.toThrow("agent failed");
      expect(closeCount).toBe(1);
    });
  });

  test("SessionEnd Hook 异常不覆盖结果且仍关闭 Root resources", async () => {
    await withTempProject(async (cwd) => {
      let closeCount = 0;
      const hooks: HookRuntime = {
        enabled: true, hasToolHooks: () => true, inspect: () => [], reload: async () => {},
        issues: [],
        async execute(input) {
          if (input.hook_event_name === "SessionEnd") {
            throw new Error("end hook failed");
          }
          return {blocked: false, additionalContexts: [], executions: []};
        },
      };
      const resources = createTestRuntimeResources(cwd, {
        hooks,
        async close() {
          closeCount += 1;
        },
      });
      const summary = await runHeadless(options(cwd), {
        createResources: async () => resources,
        runAgent: (async (_prompt, _history, onEvent) => {
          await onEvent({type:"assistant_text",content:"done",phase:"final"});
          return {reply:"done",reason:"completed",iterations:1};
        }) as AgentRunner,
        saveSession: async () => {},
        writeOutput: ignoreOutput,
        writeDiagnostic: async () => {},
      });

      expect(summary.finalResponse).toBe("done");
      expect(closeCount).toBe(1);
    });
  });

  test("Session 保存失败仍关闭 resources 且不调用 output", async () => {
    await withTempProject(async (cwd) => {
      let closeCount = 0;
      let outputCalls = 0;
      const resources = createTestRuntimeResources(cwd, {
        async close() {
          closeCount += 1;
        },
      });
      await expect(
        runHeadless(options(cwd), {
          createResources: async () => resources,
          runAgent: (async () => ({
            reply: "done",
            reason: "completed",
            iterations: 1,
          })) as AgentRunner,
          saveSession: async () => {
            throw new Error("save failed");
          },
          writeOutput: async () => {
            outputCalls += 1;
          },
        })
      ).rejects.toThrow("save failed");
      expect(outputCalls).toBe(0);
      expect(closeCount).toBe(1);
    });
  });

  test("text 收集 progress，JSON 保持 diagnostic sink 静默", async () => {
    await withTempProject(async (cwd) => {
      const runWithFormat = async (outputFormat: "text" | "json") => {
        const diagnostics: string[] = [];
        const resources = createTestRuntimeResources(cwd);
        await runHeadless(
          { ...options(cwd), outputFormat },
          {
            createResources: async () => resources,
            runAgent: (async (_input, _history, onEvent) => {
              await onEvent({
                type: "tool_call_start",
                turnId: "turn-1",
                toolCallId: "call-1",
                name: "read_file",
                args: JSON.stringify({ path: "src/a.ts" }),
              });
              await onEvent({
                type: "tool_call_end",
                turnId: "turn-1",
                toolCallId: "call-1",
                result: "done",
                outcome: "ok",
              });
              return { reply: "done", reason: "completed", iterations: 1 };
            }) as AgentRunner,
            saveSession: async () => {},
            writeOutput: ignoreOutput,
            writeDiagnostic: (line) => {
              diagnostics.push(line);
            },
          }
        );
        return diagnostics;
      };

      expect(await runWithFormat("text")).toEqual([
        '● read_file {"path":"src/a.ts"}',
        "  done",
      ]);
      expect(await runWithFormat("json")).toEqual([]);
    });
  });

  test("Agent 加载问题写入 stderr diagnostic，不混入 JSON summary", async () => {
    await withTempProject(async (cwd) => {
      const diagnostics: string[] = [];
      let output: HeadlessRunSummary | undefined;
      const subagents = createSubagentRegistry({
        definitions: [],
        issues: [{
          source: "project",
          path: `${cwd}/.pillar/agents/broken.md`,
          severity: "error",
          field: "tools",
          message: "Tool does not exist in this Runtime: missing",
        }],
      });
      const resources = createTestRuntimeResources(cwd, {subagents});

      await runHeadless(options(cwd), {
        createResources: async () => resources,
        runAgent: (async (_prompt, _history, onEvent) => {
          await onEvent({type:"assistant_text",content:"done",phase:"final"});
          return {reply:"done",reason:"completed",iterations:1};
        }) as AgentRunner,
        saveSession: async () => {},
        writeOutput(summary) {
          output = summary;
        },
        writeDiagnostic(line) {
          diagnostics.push(line);
        },
      });

      expect(diagnostics).toEqual([
        "Agent configuration: ERROR · project · broken.md · tools · Tool does not exist in this Runtime: missing",
      ]);
      expect(JSON.stringify(output)).not.toContain("broken.md");
      expect(output?.finalResponse).toBe("done");
    });
  });

  test("Agent 启动诊断写入失败仍关闭 Root resources", async () => {
    await withTempProject(async (cwd) => {
      let closeCount = 0;
      const subagents = createSubagentRegistry({
        definitions: [],
        issues: [{
          source: "project",
          path: `${cwd}/.pillar/agents/broken.md`,
          severity: "error",
          message: "broken",
        }],
      });
      const resources = createTestRuntimeResources(cwd, {
        subagents,
        async close() {
          closeCount += 1;
        },
      });

      await expect(runHeadless(options(cwd), {
        createResources: async () => resources,
        writeOutput: ignoreOutput,
        writeDiagnostic() {
          throw new Error("stderr failed");
        },
      })).rejects.toThrow("stderr failed");
      expect(closeCount).toBe(1);
    });
  });
});

test("Headless 共享 Thread 初始化失败仍运行 SessionEnd 并关闭 Root", async () => {
 await withTempProject(async cwd => {
  const events: string[] = [];
  const resources=createTestRuntimeResources(cwd,{hooks:{enabled:true,inspect:()=>[],issues:[],hasToolHooks:()=>false,reload:async()=>{},execute:async input=>{
   events.push(input.hook_event_name);
   if(input.hook_event_name==="SessionStart") throw new Error("start hook failed");
   return {blocked:false,additionalContexts:[],executions:[]};
  }},close:async()=>{events.push("closed");}});
  await expect(runHeadless(options(cwd),{createResources:async()=>resources,writeDiagnostic:()=>{},writeOutput:ignoreOutput})).rejects.toThrow("start hook failed");
  expect(events).toEqual(["SessionStart","SessionEnd","closed"]);
 });
});
