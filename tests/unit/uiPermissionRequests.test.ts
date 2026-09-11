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
      {
        allowPersistent: false,
        presentation: {
          kind: "network_access",
          host: "registry.npmjs.org",
          port: 443,
        },
      }
    );
    expect(requests.getSnapshot()?.allowAddToAllowList).toBe(false);
    expect(requests.getSnapshot()?.presentation).toEqual({
      kind: "network_access",
      host: "registry.npmjs.org",
      port: 443,
    });
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

  test("并发 pending request 排队，避免后台网络权限覆盖前台弹窗", async () => {
    const requests = new UIPermissionRequests();
    const first = requests.request("bash", "first", {});
    const firstRequest = requests.getSnapshot();
    const second = requests.request("write_file", "second", {});
    expect(requests.getSnapshot()).toBe(firstRequest);
    firstRequest?.resolve({behavior: "allow"});
    requests.clear(firstRequest);
    expect(requests.getSnapshot()?.question).toBe("second");
    requests.denyPending("stop");
    await first;
    expect(await second).toEqual({behavior: "deny", message: "stop"});
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

  test("队列内取消不会清除当前弹窗；当前取消后继续下一项", async () => {
    const requests = new UIPermissionRequests();
    const current = new AbortController();
    const queued = new AbortController();
    const first = requests.request("bash", "first", {}, {signal: current.signal});
    const firstReq = requests.getSnapshot();
    const second = requests.request("bash", "second", {}, {signal: queued.signal});
    const third = requests.request("bash", "third", {});
    queued.abort();
    expect((await second).behavior).toBe("deny");
    expect(requests.getSnapshot()).toBe(firstReq);
    current.abort();
    expect((await first).behavior).toBe("deny");
    expect(requests.getSnapshot()?.question).toBe("third");
    expect(requests.getSnapshot()?.id).not.toBe(firstReq?.id);
    requests.dispose();
    expect((await third).behavior).toBe("deny");
    expect((await requests.request("bash", "after close", {})).behavior).toBe("deny");
  });
});
