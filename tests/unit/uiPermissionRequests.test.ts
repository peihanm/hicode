import { describe, expect, test } from "bun:test";
import { UIPermissionRequests } from "../../src/ui/turn/permissionRequests.js";

describe("UIPermissionRequests", () => {
  test("暴露 request、返回 decision，并用 identity 清理", async () => {
    const requests = new UIPermissionRequests();
    const decision = requests.request("bash", "需要确认", { command: "pwd" });
    const current = requests.getSnapshot();
    expect(current).not.toBeNull();
    expect(current?.allowAddToAllowList).toBe(true);

    current?.resolve({ behavior: "allow" });
    expect(requests.clear(current)).toBe(true);
    expect(await decision).toEqual({ behavior: "allow" });
    expect(requests.getSnapshot()).toBeNull();
  });

  test("plan mode 工具不展示永久允许", () => {
    const requests = new UIPermissionRequests();
    void requests.request("enter_plan_mode", "进入计划", {});
    expect(requests.getSnapshot()?.allowAddToAllowList).toBe(false);
    requests.denyPending("stop");
  });

  test("脱离 Sandbox 的确认不展示永久允许", () => {
    const requests = new UIPermissionRequests();
    void requests.request("bash", "elevated", {
      command: "npm install",
      sandbox_permissions: "require_escalated",
    });
    expect(requests.getSnapshot()?.allowAddToAllowList).toBe(false);
    requests.denyPending("stop");
  });

  test("单次 Sandbox 网络授权不展示永久允许", () => {
    const requests = new UIPermissionRequests();
    void requests.request(
      "bash",
      "allow registry network",
      {command: "npm install"},
      {allowPersistent: false}
    );
    expect(requests.getSnapshot()?.allowAddToAllowList).toBe(false);
    requests.denyPending("stop");
  });

  test("取消只 resolve 一次，旧 request 不能清掉新 request", async () => {
    const requests = new UIPermissionRequests();
    const firstDecision = requests.request("bash", "first", {});
    const first = requests.getSnapshot();
    expect(requests.denyPending("任务已取消")).toBe(true);
    expect(requests.denyPending("again")).toBe(false);
    expect(await firstDecision).toEqual({
      behavior: "deny",
      message: "任务已取消",
    });

    const secondDecision = requests.request("write_file", "second", {});
    const second = requests.getSnapshot();
    expect(requests.clear(first)).toBe(false);
    expect(requests.getSnapshot()).toBe(second);
    second?.resolve({ behavior: "allow" });
    requests.clear(second);
    expect(await secondDecision).toEqual({ behavior: "allow" });
  });

  test("拒绝并发 pending request", async () => {
    const requests = new UIPermissionRequests();
    const first = requests.request("bash", "first", {});
    await expect(requests.request("write_file", "second", {})).rejects.toThrow(
      "已有权限请求"
    );
    requests.denyPending("stop");
    await first;
  });

  test("dispose 用 shutdown 文案解决 pending request", async () => {
    const requests = new UIPermissionRequests();
    const decision = requests.request("bash", "pending", {});
    requests.dispose();
    expect(await decision).toEqual({
      behavior: "deny",
      message: "应用正在关闭",
    });
    expect(requests.getSnapshot()).toBeNull();
  });

  test("subscriber 异常不会卡住权限请求", async () => {
    const requests = new UIPermissionRequests();
    requests.subscribe(() => {
      throw new Error("render failed");
    });
    const decision = requests.request("bash", "pending", {});
    expect(requests.denyPending("stop")).toBe(true);
    expect(await decision).toEqual({behavior: "deny", message: "stop"});
  });
});
