import { describe, expect, test } from "bun:test";
import {
  createVerificationBashTool,
} from "../../src/subagents/builtins/verification/tools.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

const cwd = "/tmp/project";

async function check(command: string) {
  return createVerificationBashTool().checkPermissions?.(
    {command},
    {cwd} as any
  );
}

describe("Verification Agent shell policy", () => {
  test("自动放行单 URL localhost 可达性探测和常见项目检查", async () => {
    expect(
      await check("curl -I http://127.0.0.1:3000/")
    ).toEqual({ behavior: "allow" });
    expect(await check("npm test")).toEqual({
      behavior: "allow",
    });
    expect(await check("bun run typecheck")).toEqual({
      behavior: "allow",
    });
    expect(
      await check("cd /tmp/project && cargo test")
    ).toEqual({ behavior: "allow" });
  });

  test("拒绝外网、安装、进程接管、任意脚本和 shell 写入", async () => {
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
      "curl --config .curlrc http://localhost:3000",
      "curl -K .curlrc http://localhost:3000",
      "curl -oout http://localhost:3000",
      "curl -sKconfig http://localhost:3000",
      "curl -XPOST http://localhost:3000",
      "sort -oout input",
      'sort "-o" out input',
      "echo $DYNAMIC_COMMAND",
      "curl http://localhost:3000 &",
    ]) {
      expect((await check(command))?.behavior).toBe(
        "deny"
      );
    }
  });

  test("Verification 保留父 Plan，不通过项目测试声明扩大写能力", async () => {
    await withTempProject(async cwd => {
      const ctx = createTestContext(cwd, {collaborationMode: "plan", permissionMode: "bypassPermissions"});
      const tool = createVerificationBashTool();
      expect((await tool.checkPermissions?.({command: "bun run test"}, ctx))?.behavior).toBe("deny");
      expect((await tool.checkPermissions?.({command: "pwd"}, ctx))?.behavior).toBe("allow");
    });
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
