import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  executeTool,
  executeToolResult,
  getToolSchemas,
} from "../helpers/executeTool.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTurnAbortController } from "../../src/runtime/abort.js";
import { attachSubagentLauncher } from "../helpers/subagentLauncher.js";

describe("tool registry contract", () => {
  test("内置清单和执行入口均不再提供 Verification", async () => {
    const schema = getToolSchemas().find(tool => tool.function.name === "agent");
    expect(JSON.stringify(schema)).not.toContain("Verification");
    await withTempProject(async cwd => {
      const ctx = createTestContext(cwd);
      let launched = false;
      attachSubagentLauncher(ctx, async () => {
        launched = true;
        throw new Error("未注册的 Agent 不得启动");
      });
      const result = await executeToolResult("agent", JSON.stringify({
        subagent_type: "Verification", description: "验证", prompt: "检查项目",
      }), ctx, "unknown-agent");
      expect(result.outcome).toBe("failed");
      expect(result.modelContent).toContain("未知 Agent 类型");
      expect(launched).toBe(false);
    });
  });

  test("所有工具都有唯一名称和 object schema", () => {
    const schemas = getToolSchemas();
    const names = schemas.map((tool) => tool.function.name);

    expect(schemas).toHaveLength(15);
    expect(names).not.toContain("bash_task");
    expect(names).toContain("view_image");
    expect(new Set(names).size).toBe(names.length);
    for (const tool of schemas) {
      expect(tool.type).toBe("function");
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  test("bash schema 引用共同验证原则并保留执行失败语义", () => {
    const bash = getToolSchemas().find(
      (tool) => tool.function.name === "bash"
    );
    expect(bash?.function.description).toContain(
      "按共同验证原则选择项目已有检查"
    );
    expect(bash?.function.description).toContain("不得通过 Bash 补造缺失的浏览器能力");
    expect(bash?.function.description).toContain("项目既有 E2E 和用户明确要求搭建自动化的任务");
    expect(JSON.stringify(bash?.function.parameters)).toContain(
      "管道任一段失败会保留非零状态"
    );
    expect(bash?.function.description).toContain("每次调用都是独立进程");
    expect(bash?.function.description).toContain("拒绝 shell 后台操作符 &");
    expect(bash?.function.description).toContain(
      "run_in_background 并省略 timeout_ms"
    );
    expect(JSON.stringify(bash?.function.parameters)).toContain(
      "不要假设上一次 cd 会保留"
    );
    expect(JSON.stringify(bash?.function.parameters)).toContain(
      "timeout_ms 不是启动等待时间"
    );
  });

  test("agent 工具校验类型并通过注入 runner 返回结构化报告", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      attachSubagentLauncher(ctx, async (request) => ({
        agentId: "agent-test",
        agentType: request.agentType,
        description: request.description,
        reply: "找到 src/agent.ts",
        reason: "completed",
        iterations: 2,
        toolUseCount: 3,
        durationMs: 15,
        transcriptPath: "/private/child-transcript.jsonl",
      }));
      const result = await executeToolResult(
        "agent",
        JSON.stringify({
          description: "调查主循环",
          prompt: "调查主循环的工具执行路径并报告证据",
          subagent_type: "Explore",
        }),
        ctx,
        "agent-call"
      );
      expect(result.outcome).toBe("ok");
      expect(result.modelContent).toBe("找到 src/agent.ts");
      expect(result.modelContent).not.toContain("child-transcript.jsonl");

      const missingRunner = await executeToolResult(
        "agent",
        JSON.stringify({
          description: "调查",
          prompt: "调查代码",
          subagent_type: "Explore",
        }),
        createTestContext(cwd),
        "agent-no-runner"
      );
      expect(missingRunner.outcome).toBe("failed");
      expect(missingRunner.modelContent).toContain("没有配置子 Agent launcher");
    });
  });

  test("agent schema 以 Root ownership 和真实并发能力约束委派", () => {
    const agent = getToolSchemas().find(
      (tool) => tool.function.name === "agent"
    );

    expect(agent?.function.description).toContain("Root 默认亲自完成顺序性的调查、实现和验证");
    expect(agent?.function.description).toContain("本身都不是委派理由");
    expect(agent?.function.description).toContain("若 Root 必须等待结果才能继续");
    expect(agent?.function.description).not.toContain("3 个以上文件");
    expect(JSON.stringify(agent?.function.parameters)).toContain("fast");
    expect(JSON.stringify(agent?.function.parameters)).toContain("run_in_background");
  });

  test("agent 调用把显式模型层级传给 registered runner", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      let selectedModel: string | undefined;
      attachSubagentLauncher(ctx, async (request) => {
        selectedModel = request.kind === "fork" ? undefined : request.model;
        return {
          agentId: "agent-model-test",
          agentType: request.agentType,
          description: request.description,
          reply: "done",
          reason: "completed",
          iterations: 1,
          toolUseCount: 0,
          durationMs: 1,
        };
      });

      const result = await executeToolResult(
        "agent",
        JSON.stringify({
          description: "快速调查",
          prompt: "调查一个边界明确的问题",
          subagent_type: "Explore",
          model: "inherit",
        }),
        ctx,
        "agent-model-call"
      );

      expect(result.outcome).toBe("ok");
      expect(selectedModel).toBe("inherit");
    });
  });

  test("未知工具、非法 JSON 和 schema 错误会变成工具结果", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      expect(await executeTool("missing", "{}", ctx)).toStartWith("未知工具:");
      expect(await executeTool("read_file", "{", ctx)).toStartWith(
        "工具参数不是合法 JSON:"
      );
      expect(await executeTool("read_file", JSON.stringify({}), ctx)).toStartWith(
        "参数校验失败:"
      );
    });
  });

  test("list_files 将目录放在文件前并保持排序", async () => {
    await withTempProject(async (cwd) => {
      await mkdir(join(cwd, "z-dir"));
      await mkdir(join(cwd, "a-dir"));
      await writeFile(join(cwd, "z.txt"), "z");
      await writeFile(join(cwd, "a.txt"), "a");

      const result = await executeTool(
        "list_files",
        JSON.stringify({ dir: "." }),
        createTestContext(cwd)
      );
      expect(result.split("\n")).toEqual([
        "a-dir/",
        "z-dir/",
        "a.txt",
        "z.txt",
      ]);
    });
  });

  test("glob 按路径模式查找文件并忽略 Git 元数据", async () => {
    await withTempProject(async (cwd) => {
      await mkdir(join(cwd, "src", "nested"), { recursive: true });
      await mkdir(join(cwd, ".git"), { recursive: true });
      await writeFile(join(cwd, "src", "main.ts"), "export {};");
      await writeFile(join(cwd, "src", "nested", "helper.ts"), "export {};");
      await writeFile(join(cwd, "src", "nested", "notes.md"), "notes");
      await writeFile(join(cwd, ".git", "hidden.ts"), "ignored");

      const result = await executeTool(
        "glob",
        JSON.stringify({ pattern: "**/*.ts", path: "." }),
        createTestContext(cwd)
      );

      expect(result.split("\n")).toEqual([
        "src/main.ts",
        "src/nested/helper.ts",
      ]);
    });
  });

  test("read_file 普通文件默认整份读取", async () => {
    await withTempProject(async (cwd) => {
      const content = Array.from(
        { length: 367 },
        (_, index) => `line-${index + 1}`
      ).join("\n");
      await writeFile(join(cwd, "page.html"), content);
      const result = await executeTool(
        "read_file",
        JSON.stringify({ path: "page.html" }),
        createTestContext(cwd)
      );

      expect(result).toContain("行范围: 1-367 / 367");
      expect(result).toContain("   367\tline-367");
      expect(result).not.toContain("本次未返回后续");
    });
  });

  test("read_file 已知区间支持分页并返回稳定行号", async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\ngamma\ndelta");
      const result = await executeTool(
        "read_file",
        JSON.stringify({ path: "notes.txt", offset: 2, limit: 2 }),
        createTestContext(cwd)
      );

      expect(result).toContain("行范围: 2-3 / 4");
      expect(result).toContain("     2\tbeta");
      expect(result).toContain("本次未返回后续 1 行");
      expect(result).not.toContain("继续读取请用");
    });
  });

  test("delete_file 要求完整读取并返回删除结果", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "remove.txt");
      await writeFile(path, "remove me\n");
      const ctx = createTestContext(cwd, {permissionMode: "ask"});

      const unread = await executeToolResult(
        "delete_file",
        JSON.stringify({path: "remove.txt"}),
        ctx,
        "delete-unread"
      );
      expect(unread.outcome).toBe("denied");

      await executeTool("read_file", JSON.stringify({path: "remove.txt"}), ctx);
      const deleted = await executeToolResult(
        "delete_file",
        JSON.stringify({path: "remove.txt"}),
        ctx,
        "delete-read"
      );
      expect(deleted.outcome).toBe("ok");
      expect(deleted.uiData).toMatchObject({
        type: "file_change",
        change: {kind: "delete", linesAdded: 0, linesRemoved: 1},
      });
      expect(existsSync(path)).toBe(false);
    });
  });

  test("grep 超过旧 100 条限制后保留完整可恢复结果", async () => {
    await withTempProject(async (cwd) => {
      const lines = Array.from(
        { length: 320 },
        (_, index) => `MATCH-${String(index).padStart(3, "0")}-${"x".repeat(80)}`
      );
      await writeFile(join(cwd, "many.txt"), lines.join("\n"));
      const ctx = createTestContext(cwd);
      const result = await executeToolResult(
        "grep",
        JSON.stringify({ pattern: "MATCH-", path: "." }),
        ctx,
        "large-grep"
      );
      expect(result.persisted?.complete).toBe(true);
      expect(result.modelContent).toContain("共 320 条匹配");

      const recovered = await executeTool("read_file", JSON.stringify({path: result.persisted!.path}), ctx);
      expect(recovered).toContain("MATCH-100");
      expect(recovered).toContain("MATCH-319");
    });
  });

  test("grep 支持类型过滤、输出模式、分页和跨行匹配", async () => {
    await withTempProject(async (cwd) => {
      await writeFile(
        join(cwd, "theme.ts"),
        ["const", "  theme = 'dark'", "const accent = 'blue'", "const end = true"].join("\n")
      );
      await writeFile(join(cwd, "theme.py"), "theme = 'python'\n");
      const ctx = createTestContext(cwd);

      const multiline = await executeToolResult(
        "grep",
        JSON.stringify({
          pattern: "const\\s+theme",
          path: ".",
          type: "ts",
          multiline: true,
          output_mode: "files_with_matches",
        }),
        ctx,
        "grep-multiline"
      );
      expect(multiline.modelContent).toContain("theme.ts");
      expect(multiline.modelContent).not.toContain("theme.py");

      const paged = await executeToolResult(
        "grep",
        JSON.stringify({
          pattern: "const",
          path: "theme.ts",
          output_mode: "content",
          offset: 1,
          head_limit: 1,
        }),
        ctx,
        "grep-page"
      );
      expect(paged.modelContent).toContain("theme.ts:3");
      expect(paged.modelContent).not.toContain("theme.ts:1");
      expect(paged.modelContent).toContain("显示 offset=1 后的 1/3");

      const counted = await executeToolResult(
        "grep",
        JSON.stringify({
          pattern: "const",
          path: ".",
          type: "ts",
          output_mode: "count",
        }),
        ctx,
        "grep-count"
      );
      expect(counted.modelContent).toContain("theme.ts: 3");
    });
  });

  test("write_file 未读取已有文件时返回前置条件失败，完整读取后可直接覆盖", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "existing.txt");
      await writeFile(path, "before");
      const ctx = createTestContext(cwd);

      const unread = await executeToolResult(
        "write_file",
        JSON.stringify({ path: "existing.txt", content: "after" }),
        ctx,
        "write-unread"
      );
      expect(unread.outcome).toBe("failed");
      expect(unread.modelContent).toContain("写入前置条件未满足");
      expect(unread.modelContent).toContain("必须先用 read_file 完整读取");
      expect(unread.modelContent).not.toContain("权限拒绝");
      expect(await readFile(path, "utf8")).toBe("before");

      await executeTool("read_file", JSON.stringify({ path: "existing.txt" }), ctx);
      const written = await executeToolResult(
        "write_file",
        JSON.stringify({ path: "existing.txt", content: "after" }),
        ctx,
        "write-after-read"
      );
      expect(written.outcome).toBe("ok");
      expect(written.modelContent).toContain("已写入 existing.txt");
      expect(await readFile(path, "utf8")).toBe("after");
    });
  });

  test("write_file 可以直接整体重写本 Runtime 刚创建的文件", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);

      const schema = getToolSchemas().find(
        (tool) => tool.function.name === "write_file"
      );
      expect(JSON.stringify(schema?.function.parameters)).not.toContain(
        "overwrite_existing"
      );

      await executeTool(
        "write_file",
        JSON.stringify({path: "created.txt", content: "first"}),
        ctx
      );
      await executeTool(
        "edit_file",
        JSON.stringify({
          path: "created.txt",
          edits: [{old_string: "first",
          new_string: "middle"}],
        }),
        ctx
      );
      const rewritten = await executeToolResult(
        "write_file",
        JSON.stringify({path: "created.txt", content: "second"}),
        ctx,
        "rewrite-created"
      );

      expect(rewritten.outcome).toBe("ok");
      expect(rewritten.modelContent).toContain("已写入 created.txt");
      expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("second");
    });
  });

  test("write_file 拒绝覆盖读取后被外部修改的文件", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "stale-write.txt");
      await writeFile(path, "before\n");
      const ctx = createTestContext(cwd);

      await executeTool("read_file", JSON.stringify({path: "stale-write.txt"}), ctx);
      await writeFile(path, "changed elsewhere\n");
      const stale = await executeToolResult(
        "write_file",
        JSON.stringify({path: "stale-write.txt", content: "replacement\n"}),
        ctx,
        "write-stale"
      );

      expect(stale.outcome).toBe("failed");
      expect(stale.modelContent).toContain("自上次 read_file 后已被修改");
      expect(await readFile(path, "utf8")).toBe("changed elsewhere\n");
    });
  });

  test("edit_file 文本不匹配返回 failed，重新读取并修正后可以继续编辑", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "main.js");
      const original = "const history = [];\n";
      await writeFile(path, original);
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        canUseTool: async () => { throw new Error("项目内编辑不应请求额外权限"); },
      });
      await executeTool("read_file", JSON.stringify({path}), ctx);
      const failed = await executeToolResult(
        "edit_file",
        JSON.stringify({path, edits: [{old_string: "let history = [];", new_string: "const history = [1];"}]}),
        ctx,
        "edit-wrong-keyword"
      );
      expect(failed.outcome).toBe("failed");
      expect(failed.modelContent).toContain("编辑失败");
      expect(failed.modelContent).toContain("找不到 old_string");
      expect(failed.modelContent).toContain("重新 read_file");
      expect(failed.modelContent).not.toContain("权限拒绝");
      expect(failed.uiData).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe(original);

      await executeTool("read_file", JSON.stringify({path}), ctx);
      const recovered = await executeToolResult(
        "edit_file",
        JSON.stringify({path, edits: [{old_string: "const history = [];", new_string: "const history = [1];"}]}),
        ctx,
        "edit-correct-keyword"
      );
      expect(recovered.outcome).toBe("ok");
      expect(recovered.uiData?.type).toBe("file_change");
      expect(await readFile(path, "utf8")).toBe("const history = [1];\n");
    });
  });

  test("edit_file 非唯一匹配属于编辑失败，Bypass 也不会执行", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "duplicate.txt");
      await writeFile(path, "same\nsame\n");
      const ctx = createTestContext(cwd);
      await executeTool("read_file", JSON.stringify({path}), ctx);
      const result = await executeToolResult(
        "edit_file", JSON.stringify({path, edits: [{old_string: "same", new_string: "changed"}]}),
        ctx, "edit-ambiguous"
      );
      expect(result.outcome).toBe("failed");
      expect(result.modelContent).toContain("匹配到 2 处");
      expect(result.modelContent).not.toContain("权限拒绝");
      expect(result.uiData).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("same\nsame\n");
    });
  });

  test("edit_file 审批期间发生外部修改时返回 failed 且保留外部内容", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "approval.txt");
      await writeFile(path, "before\n");
      let approvals = 0;
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        canUseTool: async () => {
          approvals++;
          await writeFile(path, "external\n");
          return {behavior: "allow"};
        },
      });
      ctx.permissionRules.ask.push({toolName: "edit_file", source: "host"});
      await executeTool("read_file", JSON.stringify({path}), ctx);
      const result = await executeToolResult(
        "edit_file", JSON.stringify({path, edits: [{old_string: "before", new_string: "after"}]}),
        ctx, "edit-stale-after-approval"
      );
      expect(approvals).toBe(1);
      expect(result.outcome).toBe("failed");
      expect(result.modelContent).toContain("自上次 read_file 后已被修改");
      expect(result.uiData).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("external\n");
    });
  });

  test("edit_file 真实权限规则与用户拒绝仍返回 denied", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "denied.txt");
      await writeFile(path, "before\n");
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        canUseTool: async () => ({behavior: "deny", message: "不要修改"}),
      });
      ctx.permissionRules.ask.push({toolName: "edit_file", source: "host"});
      await executeTool("read_file", JSON.stringify({path}), ctx);
      const args = JSON.stringify({path, edits: [{old_string: "before", new_string: "after"}]});
      const rejected = await executeToolResult("edit_file", args, ctx, "edit-user-denied");
      expect(rejected.outcome).toBe("denied");
      expect(rejected.modelContent).toContain("不要修改");
      ctx.permissionRules.deny.push({toolName: "edit_file", source: "host"});
      const denied = await executeToolResult("edit_file", args, ctx, "edit-rule-denied");
      expect(denied.outcome).toBe("denied");
      expect(denied.modelContent).toContain("被 deny 规则拒绝");
      expect(await readFile(path, "utf8")).toBe("before\n");
    });
  });

  test("edit_file 成功结果包含结构化 diff，模型内容保持简短", async () => {
    await withTempProject(async (cwd) => {
      await writeFile(join(cwd, "edit-me.txt"), "before\ncontext\n");
      const ctx = createTestContext(cwd, { permissionMode: "full-access" });
      await executeToolResult(
        "read_file",
        JSON.stringify({ path: "edit-me.txt" }),
        ctx,
        "read-edit"
      );
      const result = await executeToolResult(
        "edit_file",
        JSON.stringify({
          path: "edit-me.txt",
          edits: [{old_string: "before",
          new_string: "after"}],
        }),
        ctx,
        "edit-structured"
      );

      expect(result.modelContent).toContain("已修改 edit-me.txt");
      expect(result.modelContent).not.toContain("- before");
      expect(result.uiData).toMatchObject({
        type: "file_change",
        change: {
          path: "edit-me.txt",
          kind: "update",
          linesAdded: 1,
          linesRemoved: 1,
        },
      });
      expect(await readFile(join(cwd, "edit-me.txt"), "utf8")).toBe("after\ncontext\n");
    });
  });

  test("edit_file 的部分读取只授权可见片段，且状态不跨 Runtime 泄漏", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "partial.txt");
      await writeFile(path, "alpha\nbeta\ngamma\n");
      const first = createTestContext(cwd);
      const second = createTestContext(cwd);

      await executeTool(
        "read_file",
        JSON.stringify({ path: "partial.txt", offset: 2, limit: 1 }),
        first
      );
      const hidden = await executeToolResult(
        "edit_file",
        JSON.stringify({
          path: "partial.txt",
          edits: [{old_string: "alpha",
          new_string: "ALPHA"}],
        }),
        first,
        "edit-unobserved"
      );
      expect(hidden.outcome).toBe("failed");
      expect(hidden.modelContent).toContain("未展示要修改的完整内容");

      const visible = await executeTool(
        "edit_file",
        JSON.stringify({
          path: "partial.txt",
          edits: [{old_string: "beta",
          new_string: "BETA"}],
        }),
        first
      );
      expect(visible).toContain("已修改 partial.txt");

      const leaked = await executeToolResult(
        "edit_file",
        JSON.stringify({
          path: "partial.txt",
          edits: [{old_string: "BETA",
          new_string: "Beta"}],
        }),
        second,
        "edit-unread"
      );
      expect(leaked.outcome).toBe("failed");
      expect(leaked.modelContent).toContain("必须先用 read_file");
    });
  });

  test("edit_file 保留 CRLF 换行，replace_all 要求完整读取", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "crlf.txt");
      await writeFile(path, "one\r\ntwo\r\ntwo\r\n");
      const ctx = createTestContext(cwd);

      await executeTool(
        "read_file",
        JSON.stringify({ path: "crlf.txt", offset: 2, limit: 1 }),
        ctx
      );
      const denied = await executeTool(
        "edit_file",
        JSON.stringify({
          path: "crlf.txt",
          edits: [{old_string: "two",
          new_string: "TWO",
          replace_all: true}],
        }),
        ctx
      );
      expect(denied).toContain("replace_all 必须先完整读取");

      await executeTool(
        "read_file",
        JSON.stringify({ path: "crlf.txt" }),
        ctx
      );
      const edited = await executeTool(
        "edit_file",
        JSON.stringify({
          path: "crlf.txt",
          edits: [{old_string: "two",
          new_string: "TWO",
          replace_all: true}],
        }),
        ctx
      );
      expect(edited).toContain("替换 2 处");
      expect(await readFile(path, "utf8")).toBe("one\r\nTWO\r\nTWO\r\n");
    });
  });

  test("edit_file 用内容哈希拒绝读取后发生的外部修改", async () => {
    await withTempProject(async (cwd) => {
      const path = join(cwd, "stale.txt");
      await writeFile(path, "before\n");
      const ctx = createTestContext(cwd);

      await executeTool(
        "read_file",
        JSON.stringify({ path: "stale.txt" }),
        ctx
      );
      await writeFile(path, "changed elsewhere\n");

      const result = await executeTool(
        "edit_file",
        JSON.stringify({
          path: "stale.txt",
          edits: [{old_string: "changed elsewhere",
          new_string: "edited"}],
        }),
        ctx
      );
      expect(result).toContain("自上次 read_file 后已被修改");
      expect(await readFile(path, "utf8")).toBe("changed elsewhere\n");
    });
  });

  test("无回调 Ask Host 拒绝需要确认的新文件写入", async () => {
    await withTempProject(async (cwd) => {
      let asked = false;
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        collaborationMode: "build",
        permissionPromptPolicy: "never",
        canUseTool: async () => {
          asked = true;
          return { behavior: "allow" };
        },
      });
      ctx.permissionRules.ask.push({toolName: "write_file", source: "host"});
      const result = await executeTool(
        "write_file",
        JSON.stringify({ path: "new.txt", content: "hello" }),
        ctx
      );

      expect(result).toContain("当前 Host 不支持权限交互");
      expect(asked).toBe(false);
    });
  });

  test("default 自动允许 canonical workspace 内的新文件写入", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        collaborationMode: "build",
        canUseTool: async () => {
          throw new Error("workspace-scoped write_file 不应请求权限");
        },
      });
      const result = await executeToolResult(
        "write_file",
        JSON.stringify({path: "default-write.txt", content: "hello"}),
        ctx,
        "default-workspace-write"
      );

      expect(result.outcome).toBe("ok");
      expect(await readFile(join(cwd, "default-write.txt"), "utf8"))
        .toBe("hello");
    });
  });

  test("权限等待结束前取消不会执行写工具", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      let resolveDecision!: (value: { behavior: "allow" }) => void;
      let permissionRequested!: () => void;
      const requested = new Promise<void>((resolve) => {
        permissionRequested = resolve;
      });
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        collaborationMode: "build",
        signal: controller.signal,
        canUseTool: async () => {
          permissionRequested();
          return new Promise((resolve) => {
            resolveDecision = resolve;
          });
        },
      });
      ctx.permissionRules.ask.push({
        toolName: "write_file",
        source: "project",
      });

      const running = executeTool(
        "write_file",
        JSON.stringify({ path: "cancelled.txt", content: "nope" }),
        ctx
      );
      await requested;
      controller.abort("user-cancel");
      resolveDecision({ behavior: "allow" });

      expect(await running).toBe("工具调用已取消（user-cancel）");
      expect(existsSync(join(cwd, "cancelled.txt"))).toBe(false);
    });
  });

  test("权限审批不能改写普通工具输入", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        collaborationMode: "build",
        canUseTool: async () => ({
          behavior: "allow",
          updatedInput: {path: "mutated.txt", content: "changed"},
        }),
      });
      ctx.permissionRules.ask.push({
        toolName: "write_file",
        source: "project",
      });

      const result = await executeToolResult(
        "write_file",
        JSON.stringify({path: "original.txt", content: "original"}),
        ctx,
        "permission-input-mutation"
      );

      expect(result.outcome).toBe("denied");
      expect(result.modelContent).toContain("权限交互不能修改工具");
      expect(existsSync(join(cwd, "original.txt"))).toBe(false);
      expect(existsSync(join(cwd, "mutated.txt"))).toBe(false);
    });
  });

  test("权限交互异常只让当前工具失败", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        collaborationMode: "build",
        canUseTool: async () => {
          throw new Error("interaction unavailable");
        },
      });
      ctx.permissionRules.ask.push({
        toolName: "write_file",
        source: "project",
      });

      const result = await executeToolResult(
        "write_file",
        JSON.stringify({path: "not-created.txt", content: "nope"}),
        ctx,
        "permission-interaction-error"
      );

      expect(result.outcome).toBe("failed");
      expect(result.modelContent).toContain(
        "权限交互失败: interaction unavailable"
      );
      expect(existsSync(join(cwd, "not-created.txt"))).toBe(false);
    });
  });
});
