import { describe, expect, test } from "bun:test";
import {
  checkVerificationShellCommand,
  createVerificationBashTool,
} from "../../src/subagents/builtins/verification/tools.js";

const cwd = "/tmp/project";

describe("Verification Agent shell policy", () => {
  test("自动放行单 URL localhost 可达性探测和常见项目检查", () => {
    expect(
      checkVerificationShellCommand(
        "curl -I http://127.0.0.1:3000/",
        cwd
      )
    ).toEqual({ behavior: "allow" });
    expect(checkVerificationShellCommand("npm test", cwd)).toEqual({
      behavior: "allow",
    });
    expect(checkVerificationShellCommand("bun run typecheck", cwd)).toEqual({
      behavior: "allow",
    });
    expect(
      checkVerificationShellCommand("cd /tmp/project && cargo test", cwd)
    ).toEqual({ behavior: "allow" });
  });

  test("拒绝外网、安装、进程接管、任意脚本和 shell 写入", () => {
    for (const command of [
      "curl https://example.com",
      "curl http://localhost:3000/a http://localhost:3000/b",
      "curl -X POST http://localhost:3000/api/run",
      "curl --request=DELETE http://localhost:3000/api/items/1",
      "curl http://localhost:3000/api/run -d '{\"value\":1}'",
      "curl -L http://localhost:3000/",
      "npm install",
      "pkill -f server.js",
      "lsof -ti:3000 | xargs kill -9",
      "node server.js",
      "echo result > /tmp/result.txt",
      "curl http://localhost:3000 > /tmp/page.html",
      "curl http://localhost:3000 --output /tmp/page.html",
      "curl http://localhost:3000 -c /tmp/cookies.txt",
      "curl http://localhost:3000 &",
    ]) {
      expect(checkVerificationShellCommand(command, cwd).behavior).toBe(
        "deny"
      );
    }
  });

  test("每个 Verification Runtime 最多允许两次 curl 探测", async () => {
    const tool = createVerificationBashTool();
    const ctx = { cwd } as any;

    expect(
      await tool.checkPermissions?.(
        { command: "curl http://localhost:3000/" },
        ctx
      )
    ).toEqual({ behavior: "allow" });
    expect(
      await tool.checkPermissions?.(
        { command: "curl -I http://localhost:3000/app.js" },
        ctx
      )
    ).toEqual({ behavior: "allow" });
    expect(
      await tool.checkPermissions?.(
        { command: "curl http://localhost:3000/api/health" },
        ctx
      )
    ).toEqual({
      behavior: "deny",
      message:
        "Verification Agent 的 localhost curl 可达性探测预算已用尽（最多 2 次）。请使用项目测试或浏览器工具；缺少对应能力时报告 PARTIAL。",
    });

    const nextRuntimeTool = createVerificationBashTool();
    expect(
      await nextRuntimeTool.checkPermissions?.(
        { command: "curl http://localhost:3000/" },
        ctx
      )
    ).toEqual({ behavior: "allow" });
  });
});
