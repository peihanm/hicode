import {describe, expect, test} from "bun:test";
import {SandboxNetworkApproval} from "../../src/sandbox/networkApproval.js";
import {NetworkAccessSession, type NetworkAccessExecution} from "../../src/permissions/networkAccess.js";
import {UIPermissionRequests} from "../../src/ui/turn/permissionRequests.js";

const target = {host: "registry.example.test", port: 443};
const signal = () => new AbortController().signal;
const access = (canUseTool: NetworkAccessExecution["canUseTool"]): NetworkAccessExecution => ({
    session: new NetworkAccessSession(), canUseTool, canReview: () => true,
});

describe("Sandbox network approvals", () => {
    test("会话授权合并并发请求，并严格绑定域名与端口", async () => {
        const broker = new SandboxNetworkApproval();
        let asks = 0;
        const owner = access(async (_name, _message, input, options) => {
            asks++;
            expect(input).toEqual(target);
            expect(options?.allowPersistent).toBe(false);
            expect(options?.presentation).toEqual({kind: "network_access", ...target});
            return {behavior: "allow", networkScope: "session"};
        });
        const release = broker.register(owner, signal()).release;
        expect(await Promise.all([broker.ask(target), broker.ask(target)])).toEqual([true, true]);
        expect(asks).toBe(1);
        release();
        broker.register(owner, signal());
        expect(await broker.ask(target)).toBe(true);
        expect(asks).toBe(1);
        expect(owner.session.allows(target.host, 80)).toBe(false);
        expect(owner.session.allows("evil.registry.example.test", 443)).toBe(false);
        broker.close();
        expect(await broker.ask(target)).toBe(false);
    });

    test("单连接允许不扩展为 Session 授权；拒绝不会在同批执行内重复弹窗", async () => {
        const broker = new SandboxNetworkApproval();
        let asks = 0;
        const owner = access(async () => ++asks === 1
            ? {behavior: "allow", networkScope: "once"}
            : {behavior: "deny", message: "no"});
        const release = broker.register(owner, signal()).release;
        expect(await broker.ask(target)).toBe(true);
        expect(await broker.ask(target)).toBe(false);
        expect(await broker.ask(target)).toBe(false);
        expect(asks).toBe(2);
        release();
        broker.register(owner, signal());
        expect(await broker.ask(target)).toBe(false);
        expect(asks).toBe(3);
        broker.close();
    });

    test("无执行、未知来源和不同 Session 并发均 fail closed", async () => {
        const broker = new SandboxNetworkApproval();
        let asks = 0;
        const owner = access(async () => { asks++; return {behavior: "allow", networkScope: "session"}; });
        expect(await broker.ask(target)).toBe(false);
        const releaseOwner = broker.register(owner, signal()).release;
        expect(await broker.ask(target)).toBe(true);
        for (const other of [undefined, {...owner, session: new NetworkAccessSession()}]) {
            const releaseOther = broker.register(other, signal()).release;
            expect(await broker.ask(target)).toBe(false);
            releaseOther();
        }
        expect(asks).toBe(1);
        releaseOwner();
        const second = {...owner, session: new NetworkAccessSession()};
        broker.register(second, signal());
        expect(await broker.ask(target)).toBe(true);
        expect(asks).toBe(2);
        broker.close();
    });

    test("同 Session 新审批仍需确定具体命令，已有授权可被并发后台执行复用", async () => {
        const broker = new SandboxNetworkApproval();
        let asks = 0;
        const owner = access(async () => { asks++; return {behavior: "allow", networkScope: "session"}; });
        const releaseBackground = broker.register(owner, signal()).release;
        const releaseForeground = broker.register({...owner}, signal()).release;
        expect(await broker.ask(target)).toBe(false);
        releaseForeground();
        expect(await broker.ask(target)).toBe(true);
        expect(asks).toBe(1);
        const background = broker.register({...owner, canReview: () => false}, signal());
        const concurrent = broker.register({...owner}, signal());
        expect(await broker.ask(target)).toBe(true);
        expect(asks).toBe(1);
        expect(await broker.ask({...target, port: 8443})).toBe(false);
        expect(background.networkDenials.join(" ")).toContain("approval_unavailable");
        expect(background.networkDenials.join(" ")).toContain("not a user denial");
        background.release();
        concurrent.release();
        releaseBackground();
        broker.close();
    });

    test("取消与执行集合变化会撤掉弹窗，迟到的 allow 不会写入授权", async () => {
        for (const stop of ["abort", "release", "new-owner", "close"] as const) {
            const broker = new SandboxNetworkApproval();
            const requests = new UIPermissionRequests();
            let shown!: () => void;
            const visible = new Promise<void>((resolve) => { shown = resolve; });
            const owner = access((...args) => { const result = requests.request(...args); shown(); return result; });
            const controller = new AbortController();
            const release = broker.register(owner, controller.signal).release;
            const pending = broker.ask(target);
            await visible;
            const old = requests.getSnapshot();
            expect(old).not.toBeNull();
            if (stop === "abort") controller.abort();
            if (stop === "release") release();
            if (stop === "new-owner") broker.register(undefined, signal());
            if (stop === "close") broker.close();
            expect(await pending).toBe(false);
            expect(requests.getSnapshot()).toBeNull();
            old?.resolve({behavior: "allow", networkScope: "session"});
            expect(owner.session.allows(target.host, target.port)).toBe(false);
            broker.close();
            requests.dispose();
        }
    });

    test("非法目标、错误授权类型和 callback 异常不能放行", async () => {
        const broker = new SandboxNetworkApproval();
        let asks = 0;
        const release = broker.register(access(async () => {
            asks++;
            return {behavior: "allow", directoryScope: "session"};
        }), signal()).release;
        for (const bad of [{host: "evil\n.test", port: 443}, {host: "*.test", port: 443},
            {host: "test", port: undefined}, {host: "test", port: 0}]) {
            expect(await broker.ask(bad)).toBe(false);
        }
        expect(asks).toBe(0);
        expect(await broker.ask(target)).toBe(false);
        release();
        broker.register(access(async () => { throw new Error("host failure"); }), signal());
        expect(await broker.ask(target)).toBe(false);
        broker.close();
    });
});
