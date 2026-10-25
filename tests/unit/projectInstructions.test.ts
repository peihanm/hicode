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

describe("HICODE.md project instructions", () => {
  test("按用户、Git 根到 cwd、local 的顺序加载，忽略仓库外规则和其他文件名", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const repo = join(root, "repo");
      const cwd = join(repo, "packages", "web");
      await mkdir(cwd, { recursive: true });
      await mkdir(join(repo, ".git"));
      await put(join(root, "HICODE.md"), "must-not-load-outside-repository");
      await put(join(home, ".hicode", "HICODE.md"), "user-rule");
      await put(join(repo, "HICODE.md"), "repo-rule");
      await put(join(repo, ".hicode", "HICODE.md"), "repo-dot-rule");
      await put(join(repo, "HICODE.local.md"), "repo-local-rule");
      await put(join(cwd, "HICODE.md"), "web-rule");
      await put(join(cwd, ".hicode", "HICODE.md"), "web-dot-rule");
      await put(join(cwd, "HICODE.local.md"), "web-local-rule");
      await put(join(cwd, "CODE.md"), "must-not-load-old-project");
      await put(join(cwd, "CODE.local.md"), "must-not-load-old-local");
      await put(join(cwd, "CLAUDE.md"), "must-not-load");

      const loaded = await createProjectInstructionLoader({
        userHiCodeHome: join(home, ".hicode"),
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
      await mkdir(join(repo, ".git"));
      await put(join(repo, "HICODE.md"), "p".repeat(30));
      await put(join(cwd, "HICODE.local.md"), "L".repeat(20));

      const loaded = await createProjectInstructionLoader({
        userHiCodeHome: join(home, ".hicode"),
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

  test("显式 discovery boundary 不读取隔离目录外的 HICODE.md", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const outer = join(root, "outer");
      const boundary = join(outer, "isolated");
      const cwd = join(boundary, "packages", "web");
      await mkdir(cwd, {recursive: true});
      await mkdir(join(boundary, ".git"));
      await put(join(outer, "HICODE.md"), "outer-uncommitted-rule");
      await put(join(boundary, "HICODE.md"), "isolated-rule");

      const loaded = await createProjectInstructionLoader({
        userHiCodeHome: join(home, ".hicode"),
      })(
        cwd,
        boundary
      );

      expect(loaded.files.map((file) => file.content)).toEqual(["isolated-rule"]);
    });
  });

  test("非 Git 目录只读 cwd 规则，用户级和 Host 指令仍加载", async () => {
    await withTempProject(async root => {
      const cwd = join(root, "project", "app");
      const home = join(root, "home");
      await mkdir(cwd, {recursive: true});
      await put(join(root, "HICODE.md"), "outside-rule");
      await put(join(root, "project", "HICODE.md"), "parent-rule");
      await put(join(home, "HICODE.md"), "user-rule");
      await put(join(cwd, "HICODE.md"), "cwd-rule");
      await put(join(cwd, ".hicode", "HICODE.md"), "cwd-dot-rule");
      await put(join(cwd, "HICODE.local.md"), "cwd-local-rule");
      const loaded = await createProjectInstructionLoader({
        userHiCodeHome: home, sources: ["user", "project", "local"],
        hostInstructions: [{id: "host", content: "host-rule"}],
      })(cwd, root);
      expect(loaded.files.map(file => file.content)).toEqual([
        "user-rule", "cwd-rule", "cwd-dot-rule", "cwd-local-rule", "host-rule",
      ]);
    });
  });

  test("在仓库根启动不加载兄弟目录或子目录规则", async () => {
    await withTempProject(async root => {
      await mkdir(join(root, ".git"));
      await put(join(root, "HICODE.md"), "root-rule");
      await put(join(root, "frontend", "HICODE.md"), "frontend-rule");
      await put(join(root, "backend", "HICODE.md"), "backend-rule");
      const loaded = await createProjectInstructionLoader()(root, root);
      expect(loaded.files.map(file => file.content)).toEqual(["root-rule"]);
    });
  });

  test.each(["directory", "file"])("最近的 .git %s 截止祖先查找，支持嵌套仓库和 worktree 标记", async kind => {
    await withTempProject(async root => {
      const repo = join(root, "inner");
      const cwd = join(repo, "src");
      await mkdir(cwd, {recursive: true});
      await mkdir(join(root, ".git"));
      if (kind === "directory") await mkdir(join(repo, ".git"));
      else await writeFile(join(repo, ".git"), "gitdir: /not-read-by-instruction-loader\n");
      await put(join(root, "HICODE.md"), "outer-rule");
      await put(join(repo, "HICODE.md"), "inner-rule");
      await put(join(cwd, "HICODE.md"), "src-rule");
      const loaded = await createProjectInstructionLoader()(cwd, root);
      expect(loaded.files.map(file => file.content)).toEqual(["inner-rule", "src-rule"]);
    });
  });

  test("宿主边界外的 Git 根不扩大查找范围，范围内无标记时只读取 cwd", async () => {
    await withTempProject(async root => {
      const boundary = join(root, "restricted");
      const cwd = join(boundary, "src");
      await mkdir(cwd, {recursive: true});
      await mkdir(join(root, ".git"));
      await put(join(root, "HICODE.md"), "outside-rule");
      await put(join(boundary, "HICODE.md"), "parent-rule");
      await put(join(cwd, "HICODE.md"), "cwd-rule");
      const loaded = await createProjectInstructionLoader()(cwd, boundary);
      expect(loaded.files.map(file => file.content)).toEqual(["cwd-rule"]);
      await expect(createProjectInstructionLoader()(cwd, join(root, "other"))).rejects.toThrow("does not contain cwd");
    });
  });

  test("Git 标记为 symlink 时拒绝扩大范围；禁用项目来源不探测 Git", async () => {
    await withTempProject(async root => {
      const cwd = join(root, "project");
      const home = join(root, "home");
      await mkdir(cwd);
      await symlink(root, join(cwd, ".git"));
      await expect(createProjectInstructionLoader()(cwd, root)).rejects.toThrow("Invalid Git marker");
      await put(join(home, "HICODE.md"), "user-rule");
      const loaded = await createProjectInstructionLoader({sources: ["user"], userHiCodeHome: home})(cwd, root);
      expect(loaded.files.map(file => file.content)).toEqual(["user-rule"]);
    });
  });

  test("拒绝通过符号链接加载 HICODE.md", async () => {
    await withTempProject(async (root) => {
      const home = join(root, "home");
      const cwd = join(root, "repo");
      const outside = join(root, "outside.md");
      await mkdir(cwd, {recursive: true});
      await writeFile(outside, "untrusted linked instructions");
      await symlink(outside, join(cwd, "HICODE.md"));

      const loaded = await createProjectInstructionLoader({
        userHiCodeHome: join(home, ".hicode"),
      })(cwd);

      expect(loaded.files).toEqual([]);
      expect(loaded.issues.some((issue) => issue.includes("HICODE.md"))).toBe(true);
    });
  });

  test("Host 指令最后注入且不伪造文件路径", async () => {
    await withTempProject(async (cwd) => {
      await put(join(cwd, "HICODE.md"), "project-rule");
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
