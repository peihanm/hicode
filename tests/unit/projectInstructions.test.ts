import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createProjectInstructionLoader,
  formatProjectInstructions,
} from "../../src/prompt/instructions.js";
import { withTempProject } from "../helpers/tempProject.js";

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("PILLAR.md project instructions", () => {
  test("按用户、上层到 cwd、local 的顺序加载，且不兼容旧 CODE.md 或 CLAUDE.md", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const cwd = join(repo, "packages", "web");
      await mkdir(cwd, { recursive: true });
      await put(join(home, ".pillar", "PILLAR.md"), "user-rule");
      await put(join(repo, "PILLAR.md"), "repo-rule");
      await put(join(repo, ".pillar", "PILLAR.md"), "repo-dot-rule");
      await put(join(repo, "PILLAR.local.md"), "repo-local-rule");
      await put(join(cwd, "PILLAR.md"), "web-rule");
      await put(join(cwd, ".pillar", "PILLAR.md"), "web-dot-rule");
      await put(join(cwd, "PILLAR.local.md"), "web-local-rule");
      await put(join(cwd, "CODE.md"), "must-not-load-old-project");
      await put(join(cwd, "CODE.local.md"), "must-not-load-old-local");
      await put(join(cwd, "CLAUDE.md"), "must-not-load");

      const loaded = await createProjectInstructionLoader({
        userPillarHome: join(home, ".pillar"),
        sources: ["user", "project", "local"],
      })(cwd);
      expect(loaded.files.map((file) => file.content)).toEqual([
        "user-rule",
        "repo-rule",
        "repo-dot-rule",
        "repo-local-rule",
        "web-rule",
        "web-dot-rule",
        "web-local-rule",
      ]);
      expect(loaded.files.map((file) => file.scope)).toEqual([
        "user",
        "project",
        "project",
        "local",
        "project",
        "project",
        "local",
      ]);
      expect(formatProjectInstructions(loaded)).not.toContain("must-not-load");
      expect(formatProjectInstructions(loaded)).not.toContain(
        "must-not-load-old-project"
      );
      expect(formatProjectInstructions(loaded)).not.toContain(
        "must-not-load-old-local"
      );
    });
  });

  test("单文件和总预算优先保留离 cwd 最近的高优先级规则", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const cwd = join(repo, "app");
      await mkdir(cwd, { recursive: true });
      await put(join(repo, "PILLAR.md"), "p".repeat(30));
      await put(join(cwd, "PILLAR.local.md"), "L".repeat(20));

      const loaded = await createProjectInstructionLoader({
        userPillarHome: join(home, ".pillar"),
        maxFileChars: 20,
        maxTotalChars: 25,
      })(cwd);

      expect(loaded.files).toHaveLength(2);
      expect(loaded.files[0]?.content).toHaveLength(5);
      expect(loaded.files[0]?.truncated).toBe(true);
      expect(loaded.files[1]?.content).toBe("L".repeat(20));
      expect(loaded.issues.length).toBeGreaterThan(0);
    });
  });

  test("显式 discovery boundary 不读取隔离目录外的 PILLAR.md", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const outer = join(root, "outer");
      const boundary = join(outer, "isolated");
      const cwd = join(boundary, "packages", "web");
      await mkdir(cwd, {recursive: true});
      await put(join(outer, "PILLAR.md"), "outer-uncommitted-rule");
      await put(join(boundary, "PILLAR.md"), "isolated-rule");

      const loaded = await createProjectInstructionLoader({
        userPillarHome: join(home, ".pillar"),
      })(
        cwd,
        boundary
      );

      expect(loaded.files.map((file) => file.content)).toEqual(["isolated-rule"]);
    });
  });

  test("拒绝通过符号链接加载 PILLAR.md", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const cwd = join(root, "repo");
      const outside = join(root, "outside.md");
      await mkdir(cwd, {recursive: true});
      await writeFile(outside, "untrusted linked instructions");
      await symlink(outside, join(cwd, "PILLAR.md"));

      const loaded = await createProjectInstructionLoader({
        userPillarHome: join(home, ".pillar"),
      })(cwd);

      expect(loaded.files).toEqual([]);
      expect(loaded.issues.some((issue) => issue.includes("PILLAR.md"))).toBe(true);
    });
  });

  test("Host 指令最后注入且不伪造文件路径", async () => {
    await withTempProject(async (cwd) => {
      await put(join(cwd, "PILLAR.md"), "project-rule");
      const loaded = await createProjectInstructionLoader({
        sources: ["project"],
        hostInstructions: [{id: "sdk-policy", content: "host-rule"}],
      })(cwd, cwd);

      expect(loaded.files.map((file) => file.scope)).toEqual([
        "project",
        "host",
      ]);
      expect(formatProjectInstructions(loaded)).toContain("host:sdk-policy");
      expect(formatProjectInstructions(loaded).indexOf("project-rule"))
        .toBeLessThan(formatProjectInstructions(loaded).indexOf("host-rule"));
    });
  });
});
