import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { McpManagerLike } from "../../src/mcp/types.js";
import type { Tool } from "../../src/tools/types.js";
import { withTempProject } from "../helpers/tempProject.js";
import type { TaskRuntimeLike } from "../../src/tasks/index.js";
import { EMPTY_PROJECT_INSTRUCTIONS } from "../../src/prompt/instructions.js";
import {
  createRootRuntimeResourcesForTest as createRootRuntimeResources,
  createTestSettings,
} from "../helpers/runtimeResources.js";
import type { AgentDefinition } from "../../src/subagents/index.js";
import { createTestMemoryRuntime } from "../helpers/memory.js";

const loadNoInstructions = async () => EMPTY_PROJECT_INSTRUCTIONS;

function createFakeTaskRuntime(): {
  manager: TaskRuntimeLike;
  state: { closeCount: number };
} {
  const state = { closeCount: 0 };
  return {
    state,
    manager: {
      forSession() {
        throw new Error("not implemented in fixture");
      },
      hasRunning() {
        return false;
      },
      getRunningSummary() {
        return {total: 0, shell: 0, agent: 0, memory: 0};
      },
      hasRunningThatBlocksRewind() {
        return false;
      },
      async close() {
        state.closeCount += 1;
      },
    },
  };
}

function createFakeMcpManager(
  tools: Tool<any>[] = [],
  options: { initializeError?: Error; closeError?: Error } = {}
): {
  manager: McpManagerLike;
  state: { initializeCount: number; closeCount: number };
} {
  const state = { initializeCount: 0, closeCount: 0 };
  return {
    state,
    manager: {
      async initialize() {
        state.initializeCount += 1;
        if (options.initializeError) throw options.initializeError;
      },
      getSnapshots: () => [],
      getTools: () => tools,
      subscribe: () => () => {},
      async closeAll() {
        state.closeCount += 1;
        if (options.closeError) throw options.closeError;
      },
    },
  };
}

describe("RootRuntimeResources", () => {
  test("Root 把 Host Instructions、Skills 和 Agents 装入同一 snapshot", async () => {
    await withTempProject(async (cwd) => {
      const resources = await createRootRuntimeResources(
        {
          cwd,
          settings: createTestSettings(),
          fileSources: {
            settings: [],
            instructions: [],
            skills: [],
            agents: [],
            mcp: [],
          },
          rootContributions: {
            instructions: [{id: "policy", content: "host instruction"}],
            skills: [{
              name: "host-skill",
              description: "host skill",
              content: "host skill content",
            }],
            agents: [{
              name: "host-reviewer",
              description: "host reviewer",
              systemPrompt: "review the project",
              tools: ["read_file"],
            }],
          },
        },
        {mcpManager: false}
      );

      expect(resources.instructions.files).toEqual([{
        id: "policy",
        scope: "host",
        content: "host instruction",
        truncated: false,
      }]);
      expect(resources.skills.find((skill) => skill.name === "host-skill"))
        .toMatchObject({source: "host", id: "host-skill"});
      expect(resources.subagents.get("host-reviewer")?.definition)
        .toMatchObject({source: "host", id: "host-reviewer"});
      await resources.subagents.reload();
      expect(resources.subagents.has("host-reviewer")).toBe(true);
      await resources.close();
    });
  });

  test("Memory 仅装配给 Root，并明确拒绝自定义子 Agent 请求", async () => {
    await withTempProject(async (cwd) => {
      const memory = createTestMemoryRuntime(cwd, {
        autoExtract: true,
      });
      const resources = await createRootRuntimeResources(
        {
          cwd,
          settings: createTestSettings({
            memory: { enabled: true, autoExtract: true },
          }),
        },
        {
          mcpManager: false,
          memory,
          loadedCustomAgents: {
            definitions: [
              {
                agentType: "memory-reader",
                whenToUse: "读取长期记忆",
                systemPrompt: "读取长期记忆",
                allowedTools: ["memory"],
                model: "inherit",
                source: "project",
                path: `${cwd}/.pillar/agents/memory-reader.md`,
              },
            ],
            issues: [],
          },
        }
      );

      expect(resources.toolRuntime.toolNames).not.toContain("memory");
      expect(resources.memory.enabled).toBe(true);
      expect(resources.subagents.has("memory-reader")).toBe(false);
      expect(resources.subagents.issues.some((issue) =>
        issue.message.includes("当前 Runtime 不存在工具: memory")
      )).toBe(true);
      await resources.close();
    });
  });

  test("每个 Root 绑定独立的自定义 Agent Registry 和动态 Agent Tool", async () => {
    await withTempProject(async (cwd) => {
      const custom = (agentType: string): AgentDefinition => ({
        agentType,
        whenToUse: `使用 ${agentType} 检查代码`,
        systemPrompt: `你是 ${agentType}`,
        allowedTools: ["read_file", "grep"],
        model: "inherit",
        maxIterations: 8,
        source: "project",
        path: `${cwd}/.pillar/agents/${agentType}.md`,
      });
      const first = await createRootRuntimeResources({
        cwd,
        settings: createTestSettings(),
      }, {
        mcpManager: false,
        loadedCustomAgents: {
          definitions: [custom("reviewer")],
          issues: [],
        },
      });
      const second = await createRootRuntimeResources({
        cwd,
        settings: createTestSettings(),
      }, {
        mcpManager: false,
        loadedCustomAgents: {
          definitions: [custom("architecture-reader")],
          issues: [],
        },
      });

      expect(first.subagents.has("reviewer")).toBe(true);
      expect(first.subagents.has("architecture-reader")).toBe(false);
      expect(second.subagents.has("architecture-reader")).toBe(true);
      expect(second.subagents.has("reviewer")).toBe(false);
      const firstAgentSchema = first.toolRuntime.getToolSchemas().find(
        (tool) => tool.function.name === "agent"
      );
      const secondAgentSchema = second.toolRuntime.getToolSchemas().find(
        (tool) => tool.function.name === "agent"
      );
      expect(firstAgentSchema?.function.description).toContain("reviewer");
      expect(firstAgentSchema?.function.description)
        .not.toContain("architecture-reader");
      expect(secondAgentSchema?.function.description)
        .toContain("architecture-reader");
      expect(first.toolRuntime.isConcurrencySafe(
        "agent",
        JSON.stringify({
          subagent_type: "reviewer",
          description: "review",
          prompt: "review",
        })
      )).toBe(false);

      await Promise.all([first.close(), second.close()]);
    });
  });

  test("统一加载 Skills、PILLAR.md 和 MCP tools，并发 close 保持幂等", async () => {
    await withTempProject(async (cwd) => {
      const dynamicTool: Tool<any> = {
        name: "mcp__fixture__runtime",
        description: "runtime fixture",
        parameters: z.object({}),
        execute: async () => "ok",
      };
      const mcp = createFakeMcpManager([dynamicTool]);
      const background = createFakeTaskRuntime();
      let skillLoads = 0;
      let instructionLoads = 0;
      const resources = await createRootRuntimeResources({
        cwd,
        settings: createTestSettings(),
      }, {
        mcpManager: mcp.manager,
        loadSkills: () => {
          skillLoads += 1;
          return [];
        },
        loadProjectInstructions: async () => {
          instructionLoads += 1;
          return {
            files: [{
              path: `${cwd}/PILLAR.md`,
              scope: "project",
              content: "runtime instructions",
              truncated: false,
            }],
            issues: [],
          };
        },
        taskRuntime: background.manager,
        loadedCustomAgents: {
          definitions: [{
            agentType: "mcp-reader",
            whenToUse: "读取 fixture MCP",
            systemPrompt: "read fixture",
            allowedTools: ["mcp__fixture__runtime"],
            model: "inherit",
            maxIterations: 5,
            source: "project",
            path: `${cwd}/.pillar/agents/mcp-reader.md`,
          }],
          issues: [],
        },
      });

      expect(resources.cwd).toBe(cwd);
      expect(resources.model).toBe("glm-test");
      expect(resources.mcpManager).toBe(mcp.manager);
      expect(resources.toolRuntime.toolNames).toContain("mcp__fixture__runtime");
      expect(resources.subagents.has("mcp-reader")).toBe(true);
      expect(mcp.state.initializeCount).toBe(1);
      expect(skillLoads).toBe(1);
      expect(instructionLoads).toBe(1);
      expect(resources.instructions.files[0]?.content).toBe("runtime instructions");

      resources.beginShutdown();
      resources.beginShutdown();
      const firstClose = resources.close();
      const secondClose = resources.close();
      expect(firstClose).toBe(secondClose);
      await Promise.all([firstClose, secondClose, resources.close()]);
      expect(mcp.state.closeCount).toBe(1);
      expect(background.state.closeCount).toBe(1);
    });
  });

  test("MCP initialize 失败时关闭全部已创建资源并保留原始错误", async () => {
    await withTempProject(async (cwd) => {
      const original = new Error("initialize failed");
      const mcp = createFakeMcpManager([], {
        initializeError: original,
        closeError: new Error("close also failed"),
      });

      await expect(
        createRootRuntimeResources({
          cwd,
          settings: createTestSettings(),
        }, {
          mcpManager: mcp.manager,
          loadSkills: () => [],
          loadProjectInstructions: loadNoInstructions,
        })
      ).rejects.toBe(original);
      expect(mcp.state.closeCount).toBe(1);
    });
  });

  test("ToolRuntime 构造失败同样回滚，禁用 MCP 时仍返回 builtin runtime", async () => {
    await withTempProject(async (cwd) => {
      const mcp = createFakeMcpManager();
      const original = new Error("tool runtime failed");

      await expect(
        createRootRuntimeResources({
          cwd,
          settings: createTestSettings(),
        }, {
          mcpManager: mcp.manager,
          loadSkills: () => [],
          loadProjectInstructions: loadNoInstructions,
          createToolRuntime: () => {
            throw original;
          },
        })
      ).rejects.toBe(original);
      expect(mcp.state.closeCount).toBe(1);

      const disabled = await createRootRuntimeResources({
        cwd,
        settings: createTestSettings(),
      }, {
        mcpManager: false,
        loadSkills: () => [],
        loadProjectInstructions: loadNoInstructions,
      });
      expect(disabled.mcpManager).toBeUndefined();
      expect(disabled.toolRuntime.toolNames).toContain("read_file");
      await disabled.close();
    });
  });
});
