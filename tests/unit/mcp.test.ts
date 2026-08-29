import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildMcpToolName,
  createMcpApprovalIdentity,
  loadMcpConfig,
  normalizeMcpName,
  normalizeMcpResult,
} from "../../src/mcp/index.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("MCP config and normalization", () => {
  test("项目配置覆盖用户配置，单个无效 Server 不影响其他项", async () => {
    await withTempProject(async (cwd) => {
      const userPath = join(cwd, "user-mcp.json");
      const projectPath = join(cwd, ".mcp.json");
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
      const loaded = await loadMcpConfig({ cwd, userConfigPath: userPath, projectConfigPath: projectPath });
      expect(loaded.servers.map((item) => item.name).sort()).toEqual(["shared", "valid"]);
      expect(loaded.servers.find((item) => item.name === "shared")).toMatchObject({
        source: "project",
        config: { command: "project-command", args: [] },
      });
      expect(loaded.issues.some((item) => item.serverName === "invalid")).toBe(true);
    });
  });

  test("Pillar 原生项目配置覆盖根目录 Claude 兼容配置", async () => {
    await withTempProject(async (cwd) => {
      const userPath = join(cwd, "user.json");
      const compatPath = join(cwd, ".mcp.json");
      const projectPath = join(cwd, ".pillar", "mcp.json");
      await mkdir(join(cwd, ".pillar"), { recursive: true });
      await writeFile(userPath, JSON.stringify({
        mcpServers: { shared: { command: "user" } },
      }));
      await writeFile(compatPath, JSON.stringify({
        mcpServers: { shared: { command: "claude-compatible" }, compat: { command: "compat" } },
      }));
      await writeFile(projectPath, JSON.stringify({
        mcpServers: { shared: { command: "pillar-native" } },
      }));
      const loaded = await loadMcpConfig({
        cwd,
        userConfigPath: userPath,
        compatProjectConfigPath: compatPath,
        projectConfigPath: projectPath,
      });
      expect(loaded.servers.find((item) => item.name === "shared")?.config.command)
        .toBe("pillar-native");
      expect(loaded.servers.find((item) => item.name === "compat")?.config.command)
        .toBe("compat");
    });
  });

  test("工具名规范化稳定且结果不会把 base64 放进上下文", () => {
    expect(normalizeMcpName("git-hub.com")).toBe("git_hub_com");
    expect(buildMcpToolName("git-hub", "read.issue")).toBe("mcp__git_hub__read_issue");
    const longName = buildMcpToolName("server".repeat(20), "tool".repeat(30));
    expect(longName.length).toBeLessThanOrEqual(64);
    expect(longName).toMatch(/^mcp__[A-Za-z0-9_]+_[a-f0-9]{8}$/);
    const base64 = Buffer.from("secret-binary").toString("base64");
    const result = normalizeMcpResult({
      content: [{ type: "image", data: base64, mimeType: "image/png" }],
      structuredContent: { ok: true },
    });
    expect(result).toContain("image content omitted");
    expect(result).toContain("image/png");
    expect(result).not.toContain(base64);
    expect(result).toContain('{"ok":true}');
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
});
