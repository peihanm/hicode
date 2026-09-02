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
    test("展示三个权限 Profile，普通模式可直接切换", async () => {
        const onSelect = mock(() => {});
        const instance = render(
            <PermissionsDialog
                current="default"
                onSelect={onSelect}
                onClose={() => {}}
            />
        );
        await flush();

        const frame = instance.lastFrame() ?? "";
        expect(frame).toContain("◆ PERMISSIONS");
        expect(frame).toContain("Default");
        expect(frame).toContain("Read Only");
        expect(frame).toContain("Bypass");

        instance.stdin.write(DOWN);
        await flush();
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("readOnly");
    });

    test("Bypass 必须二次确认且默认返回，不会误触启用", async () => {
        const onSelect = mock(() => {});
        const instance = render(
            <PermissionsDialog
                current="default"
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

        expect(instance.lastFrame()).toContain("◆ ENABLE BYPASS?");
        expect(instance.lastFrame()).toContain("Deny/ask rules");
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).not.toHaveBeenCalled();
        expect(instance.lastFrame()).toContain("◆ PERMISSIONS");

        instance.stdin.write(ENTER);
        await flush();
        instance.stdin.write(UP);
        await flush();
        instance.stdin.write(ENTER);
        await flush();
        expect(onSelect).toHaveBeenCalledWith("bypassPermissions");
    });
});
