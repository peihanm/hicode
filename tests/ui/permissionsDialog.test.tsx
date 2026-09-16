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
        expect(frame).toContain("◆ Execution permissions");
        expect(frame).toContain("Ask for approval");
        expect(frame).toContain("Approve for me");
        expect(frame).toContain("Full Access");
        expect(frame).toContain("› Ask for approval  (current)");
        expect(frame).not.toContain("●");
        const lines = frame.split("\n");
        const title = lines.find(line => line.includes("Ask for approval"))!;
        const description = lines.find(line => line.includes("Workspace reads"))!;
        expect(title.indexOf("Ask")).toBe(description.indexOf("Workspace"));
        expect(frame).toMatch(/require approval\.\n\s*\n/);
        expect(frame).toContain("this controls access and approval");
        expect(frame).not.toContain("Read Only");
        expect(frame).not.toContain("Bypass");

        instance.stdin.write(DOWN);
        await flush();
        expect(instance.lastFrame()).toContain("› Approve for me");
        expect(instance.lastFrame()).toContain("Ask for approval  (current)");
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

        expect(instance.lastFrame()).toContain("◆ Enable Full Access?");
        expect(instance.lastFrame()).toContain("Commands will run outside HiCode sandbox isolation");
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).not.toHaveBeenCalled();
        expect(instance.lastFrame()).toContain("◆ Execution permissions");

        instance.stdin.write(ENTER);
        await flush();
        instance.stdin.write(UP);
        await flush();
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("full-access");
    });
});
