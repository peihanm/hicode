import {afterEach, describe, expect, mock, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {PermissionsDialog} from "../../src/ui/dialogs/PermissionsDialog.js";

afterEach(() => cleanup());

const ENTER = "\r";
const DOWN = "\u001B[B";
const UP = "\u001B[A";

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("PermissionsDialog", () => {
    test("展示实际审批行为，修改前确认可直接切换", async () => {
        const onSelect = mock(() => {});
        const instance = render(
            <PermissionsDialog allowFullAccess={true}
                current="ask"
                onSelect={onSelect}
                onClose={() => {}}
            />
        );
        await flush();

        const frame = instance.lastFrame() ?? "";
        expect(frame).toContain("◆ 执行权限");
        expect(frame).toContain("Ask for approval");
        expect(frame).toContain("Approve for me");
        expect(frame).toContain("Full Access");
        expect(frame).toContain("› Ask for approval  (当前)");
        expect(frame).not.toContain("●");
        const lines = frame.split("\n");
        const title = lines.find(line => line.includes("Ask for approval"))!;
        const description = lines.find(line => line.includes("工作区内读写"))!;
        expect(title.indexOf("Ask")).toBe(description.indexOf("工作区"));
        expect(frame).toMatch(/需要你批准。\n\s*\n/);
        expect(frame).toContain("此处决定访问范围和审批方式");
        expect(frame).not.toContain("Read Only");
        expect(frame).not.toContain("Bypass");

        instance.stdin.write(DOWN);
        await flush();
        expect(instance.lastFrame()).toContain("› Approve for me");
        expect(instance.lastFrame()).toContain("Ask for approval  (当前)");
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("auto-review");
    });

    test("自动批准普通操作必须二次确认且默认返回", async () => {
        const onSelect = mock(() => {});
        const instance = render(
            <PermissionsDialog allowFullAccess={true}
                current="ask"
                onSelect={onSelect}
                onClose={() => {}}
            />
        );
        await flush();
        instance.stdin.write(DOWN);
        instance.stdin.write(DOWN);
        await flush();
        instance.stdin.write(ENTER);
        await flush();

        expect(instance.lastFrame()).toContain("◆ 启用 Full Access？");
        expect(instance.lastFrame()).toContain("命令将不受 Pillar 沙箱隔离");
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).not.toHaveBeenCalled();
        expect(instance.lastFrame()).toContain("◆ 执行权限");

        instance.stdin.write(ENTER);
        await flush();
        instance.stdin.write(UP);
        await flush();
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("full-access");
    });
});
