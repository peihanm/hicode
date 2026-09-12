import { describe, expect, test } from "bun:test";
import {mkdir, symlink, writeFile} from "node:fs/promises";
import { join } from "node:path";
import {
  createMcpApprovalIdentity,
  getMcpApproval,
  saveMcpApproval,
} from "../../src/mcp/approval.js";
import {loadMcpConfig} from "../../src/mcp/config.js";
import {buildMcpToolName, normalizeMcpName} from "../../src/mcp/names.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("MCP config and normalization", () => {
  test("项目配置覆盖用户配置，单个无效 Server 不影响其他项", async () => {
    await withTempProject(async (cwd, storage) => {
      const userPath = join(storage.pillarHome, "mcp.json");
      const projectPath = join(cwd, ".mcp.json");
      await mkdir(storage.pillarHome, {recursive: true});
      await writeFile(userPath, JSON.stringify({
        mcpServers: {
          shared: { command: "user-command" },
          valid: { command: "valid-command", args: ["a"] },
        },
      }));
      await writeFile(projectPath, JSON.stringify({
        mcpServers: {
          shared: { type: "stdio", command: "project-command" },
          invalid: { command: "" },
        },
      }));
      const loaded = await loadMcpConfig(storage, cwd);
      expect(loaded.servers.map((item) => item.name).sort()).toEqual(["shared", "valid"]);
      expect(loaded.servers.find((item) => item.name === "shared")).toMatchObject({
        source: "project",
        config: { command: "project-command", args: [] },
      });
      expect(loaded.issues.some((item) => item.serverName === "invalid")).toBe(true);
    });
  });

  test("Pillar 原生项目配置覆盖根目录 Claude 兼容配置", async () => {
    await withTempProject(async (cwd, storage) => {
      const userPath = join(storage.pillarHome, "mcp.json");
      const compatPath = join(cwd, ".mcp.json");
      const projectPath = join(cwd, ".pillar", "mcp.json");
      await Promise.all([
        mkdir(join(cwd, ".pillar"), { recursive: true }),
        mkdir(storage.pillarHome, {recursive: true}),
      ]);
      await writeFile(userPath, JSON.stringify({
        mcpServers: { shared: { command: "user" } },
      }));
      await writeFile(compatPath, JSON.stringify({
        mcpServers: { shared: { command: "claude-compatible" }, compat: { command: "compat" } },
      }));
      await writeFile(projectPath, JSON.stringify({
        mcpServers: { shared: { command: "pillar-native" } },
      }));
      const loaded = await loadMcpConfig(storage, cwd);
      expect(loaded.servers.find((item) => item.name === "shared")?.config.command)
        .toBe("pillar-native");
      expect(loaded.servers.find((item) => item.name === "compat")?.config.command)
        .toBe("compat");
    });
  });

  test("Host stdio 配置复用 Schema 并覆盖同名文件来源", async () => {
    await withTempProject(async (cwd, storage) => {
      await writeFile(join(cwd, ".mcp.json"), JSON.stringify({
        mcpServers: {shared: {command: "project-command"}},
      }));
      const loaded = await loadMcpConfig(
        storage,
        cwd,
        ["project"],
        [{
          name: "shared",
          command: "host-command",
          args: ["serve"],
        }]
      );

      expect(loaded.servers).toHaveLength(1);
      expect(loaded.servers[0]).toEqual({
        name: "shared",
        source: "host",
        id: "shared",
        config: {
          type: "stdio",
          command: "host-command",
          args: ["serve"],
          disabled: false,
          timeoutMs: 10_000,
          toolTimeoutMs: 120_000,
        },
      });
    });
  });

  test("symlink 配置只产生 issue，不会加载目标 Server", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(storage.pillarHome, {recursive: true});
      const target = join(cwd, "outside-mcp.json");
      await writeFile(target, JSON.stringify({
        mcpServers: {leaked: {command: "should-not-load"}},
      }));
      await symlink(target, join(storage.pillarHome, "mcp.json"));

      const loaded = await loadMcpConfig(storage, cwd);
      expect(loaded.servers.some((server) => server.name === "leaked"))
        .toBe(false);
      expect(loaded.issues.some((issue) =>
        issue.message.includes("safely read")
      )).toBe(true);
    });
  });

  test("工具名规范化稳定", () => {
    expect(normalizeMcpName("git-hub.com")).toBe("git_hub_com");
    expect(buildMcpToolName("git-hub", "read.issue")).toBe("mcp__git_hub__read_issue");
    const longName = buildMcpToolName("server".repeat(20), "tool".repeat(30));
    expect(longName.length).toBeLessThanOrEqual(64);
    expect(longName).toMatch(/^mcp__[A-Za-z0-9_]+_[a-f0-9]{8}$/);
  });

  test("审批 Hash 随 Env Secret 变化但不暴露 Secret", async () => {
    await withTempProject(async (cwd) => {
      await mkdir(join(cwd, ".pillar"), { recursive: true });
      const base = {
        name: "server",
        source: "project" as const,
        path: join(cwd, ".mcp.json"),
        config: {
          type: "stdio" as const,
          command: "node",
          args: ["server.js"],
          disabled: false,
          timeoutMs: 10_000,
          toolTimeoutMs: 120_000,
        },
      };
      const first = await createMcpApprovalIdentity(cwd, {
        ...base,
        config: { ...base.config, env: { TOKEN: "alpha-secret" } },
      });
      const second = await createMcpApprovalIdentity(cwd, {
        ...base,
        config: { ...base.config, env: { TOKEN: "beta-secret" } },
      });
      expect(first.configHash).not.toBe(second.configHash);
      expect(JSON.stringify(first)).not.toContain("alpha-secret");
    });
  });

  test("损坏的审批文档 fail closed，不能被 mutation 覆盖", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(storage.pillarHome, {recursive: true});
      const path = join(storage.pillarHome, "mcp-approvals.json");
      await writeFile(path, "{broken", "utf8");
      const identity = {
        projectPath: cwd,
        configHash: "a".repeat(64),
      };
      await expect(getMcpApproval(path, identity, "fixture")).rejects.toThrow();
      await expect(
        saveMcpApproval(path, identity, "fixture", "always")
      ).rejects.toThrow();
    });
  });
});
