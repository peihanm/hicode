import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import {tmpdir} from "node:os";
import {
  addToAllowList,
} from "../../src/permissions/index.js";
import type { PermissionRules } from "../../src/permissions/index.js";
import { resolvePermission } from "../../src/permissions/resolvePermission.js";
import type { Tool } from "../../src/tools/types.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { loadPillarSettings } from "../../src/settings/index.js";

const inputSchema = z.object({ path: z.string().optional() });

function createTool(
  overrides: Partial<Tool<typeof inputSchema>> = {}
): Tool<typeof inputSchema> {
  return {
    name: "synthetic",
    description: "test tool",
    parameters: inputSchema,
    execute: async () => "ok",
    ...overrides,
  };
}

describe("resolvePermission", () => {
  test("只读工具默认放行，写工具默认询问", async () => {
    const ctx = createTestContext("/tmp/project", { permissionMode: "default" });
    await expect(
      resolvePermission(createTool({ isReadOnly: () => true }), {}, ctx)
    ).resolves.toEqual({ behavior: "allow" });
    await expect(resolvePermission(createTool(), {}, ctx)).resolves.toMatchObject({
      behavior: "ask",
    });
  });

  test("deny 和 ask 规则不会被 bypassPermissions 绕过", async () => {
    const ctx = createTestContext("/tmp/project", {
      permissionMode: "bypassPermissions",
        collaborationMode: "build",
    });
    ctx.permissionRules.deny.push({ toolName: "synthetic", source: "project" });
    await expect(resolvePermission(createTool(), {}, ctx)).resolves.toMatchObject({
      behavior: "deny",
    });

    ctx.permissionRules.deny = [];
    ctx.permissionRules.ask.push({ toolName: "synthetic", source: "project" });
    await expect(resolvePermission(createTool(), {}, ctx)).resolves.toMatchObject({
      behavior: "ask",
    });
  });

  test("工具自身 deny 始终优先", async () => {
    const ctx = createTestContext("/tmp/project", {
      permissionMode: "bypassPermissions",
        collaborationMode: "build",
    });
    const tool = createTool({
      checkPermissions: async () => ({ behavior: "deny", message: "stale" }),
    });
    await expect(resolvePermission(tool, {}, ctx)).resolves.toEqual({
      behavior: "deny",
      message: "stale",
    });
  });

  test("非交互 Host 将询问转换成拒绝", async () => {
    const ctx = createTestContext("/tmp/project", {
      permissionMode: "readOnly",
      permissionPromptPolicy: "never",
    });
    await expect(resolvePermission(createTool(), {}, ctx)).resolves.toEqual({
      behavior: "deny",
      message: "当前 Host 不支持权限交互，需要确认的操作被拒绝",
    });
  });

  test("Read Only 自动允许读取，但写操作仍需确认", async () => {
    const ctx = createTestContext("/tmp/project", {permissionMode: "readOnly"});
    await expect(resolvePermission(
      createTool({isReadOnly: () => true}),
      {},
      ctx
    )).resolves.toEqual({behavior: "allow"});
    await expect(resolvePermission(createTool(), {}, ctx)).resolves.toEqual({
      behavior: "ask",
      message: "Read Only 模式下工具 synthetic 需要确认",
    });
  });

  test("default 只自动放行 canonical workspace 内声明范围的写入", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd, {permissionMode: "default"});
      const tool = createTool({
        checkPermissions: async () => ({behavior: "ask", message: "write"}),
        getDefaultApprovalScope: ({path}) =>
          path ? {kind: "workspace", path} : undefined,
      });

      await expect(resolvePermission(tool, {path: "src/a.ts"}, ctx))
        .resolves.toEqual({behavior: "allow"});
      await expect(resolvePermission(tool, {path: "../outside.ts"}, ctx))
        .resolves.toEqual({behavior: "ask", message: "write"});

      if (process.platform !== "win32") {
        await symlink(tmpdir(), join(cwd, "default-linked"));
        await expect(resolvePermission(
          tool,
          {path: "default-linked/file.ts"},
          ctx
        )).resolves.toEqual({behavior: "ask", message: "write"});
      }
    });
  });

  test("default 自动放行 sandboxed scope，但显式 ask 和 plan 仍优先", async () => {
    const tool = createTool({
      checkPermissions: async () => ({behavior: "ask", message: "command"}),
      getDefaultApprovalScope: () => ({kind: "sandboxed"}),
    });
    const defaultContext = createTestContext("/tmp/project", {
      permissionMode: "default",
        collaborationMode: "build",
    });
    await expect(resolvePermission(tool, {}, defaultContext)).resolves.toEqual({
      behavior: "allow",
    });

    defaultContext.permissionRules.ask.push({
      toolName: "synthetic",
      source: "project",
    });
    await expect(resolvePermission(tool, {}, defaultContext)).resolves.toMatchObject({
      behavior: "ask",
    });

    const planContext = createTestContext("/tmp/project", {
      permissionMode: "default",
        collaborationMode: "plan",
    });
    await expect(resolvePermission(tool, {}, planContext)).resolves.toEqual({
      behavior: "ask",
      message: "command",
    });
  });

  test("Plan 在 Bypass 之前收窄写操作", async () => {
    const context = createTestContext("/tmp/project", {
      permissionMode: "bypassPermissions",
      collaborationMode: "plan",
    });
    await expect(resolvePermission(createTool(), {}, context)).resolves.toEqual({
      behavior: "ask",
      message: "Plan 模式下工具 synthetic 需要确认",
    });
  });
});

describe("permission rule persistence", () => {
  test("新增 local allow rule 同时更新文件和返回值且重复追加幂等", async () => {
    await withTempProject(async (cwd) => {
      const emptyRules: PermissionRules = { allow: [], ask: [], deny: [] };
      const first = await addToAllowList("write_file", emptyRules, cwd);
      const second = await addToAllowList("write_file", first, cwd);

      expect(first.allow).toEqual([
        { toolName: "write_file", source: "local" },
      ]);
      expect(second.allow).toEqual(first.allow);

      const settings = JSON.parse(
        await readFile(join(cwd, ".pillar", "settings.local.json"), "utf8")
      );
      expect(settings.permissions.allow).toEqual(["write_file"]);
    });
  });

  test("loader 和持久化共用统一的 rule 解析语义", async () => {
    await withTempProject(async (cwd, storage) => {
      let rules: PermissionRules = { allow: [], ask: [], deny: [] };
      for (const rule of [
        "write_file",
        "bash(git status:*)",
        "read_file(*)",
        "list_files()",
      ]) {
        rules = await addToAllowList(rule, rules, cwd);
      }

      expect(loadPillarSettings({storage, cwd}).values.permissions.rules.allow).toEqual([
        { toolName: "write_file", source: "local" },
        { toolName: "bash", content: "git status:*", source: "local" },
        { toolName: "read_file", source: "local" },
        { toolName: "list_files", source: "local" },
      ]);
    });
  });

  test("并发追加不同规则时保留完整并集", async () => {
    await withTempProject(async (cwd) => {
      const emptyRules: PermissionRules = { allow: [], ask: [], deny: [] };
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          addToAllowList(`tool_${index}`, emptyRules, cwd)
        )
      );

      const settings = JSON.parse(
        await readFile(join(cwd, ".pillar", "settings.local.json"), "utf8")
      );
      expect([...settings.permissions.allow].sort()).toEqual(
        Array.from({ length: 10 }, (_, index) => `tool_${index}`).sort()
      );
    });
  });

  test("保留未知字段、ask 和 deny", async () => {
    await withTempProject(async (cwd) => {
      const settingsPath = join(cwd, ".pillar", "settings.local.json");
      await mkdir(join(cwd, ".pillar"), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          custom: { keep: true },
          permissions: {
            ask: ["bash(rm:*)"],
            deny: ["write_file"],
          },
        })}\n`,
        "utf8"
      );
      const emptyRules: PermissionRules = { allow: [], ask: [], deny: [] };

      await addToAllowList("read_file", emptyRules, cwd);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        custom: { keep: true },
        permissions: {
          ask: ["bash(rm:*)"],
          deny: ["write_file"],
          allow: ["read_file"],
        },
      });
    });
  });

  test("损坏 settings 时拒绝覆盖且不更新内存 rules", async () => {
    await withTempProject(async (cwd) => {
      const settingsPath = join(cwd, ".pillar", "settings.local.json");
      await mkdir(join(cwd, ".pillar"), { recursive: true });
      await writeFile(settingsPath, "{corrupt-settings", "utf8");
      const emptyRules: PermissionRules = { allow: [], ask: [], deny: [] };

      await expect(
        addToAllowList("write_file", emptyRules, cwd)
      ).rejects.toThrow("Cannot update corrupt settings");
      expect(await readFile(settingsPath, "utf8")).toBe("{corrupt-settings");
      expect(emptyRules.allow).toEqual([]);
    });
  });

  test.skipIf(process.platform === "win32")(
    "权限规则拒绝通过 symlink .pillar 目录写出项目边界",
    async () => {
      await withTempProject(async (cwd) => {
        const outside = join(cwd, "outside");
        await mkdir(outside);
        await symlink(outside, join(cwd, ".pillar"));
        const emptyRules: PermissionRules = { allow: [], ask: [], deny: [] };

        await expect(addToAllowList("write_file", emptyRules, cwd))
          .rejects.toThrow("unsafe .pillar directory");
        await expect(readFile(join(outside, "settings.local.json"), "utf8"))
          .rejects.toThrow();
      });
    }
  );
});
