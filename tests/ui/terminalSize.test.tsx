import {afterEach, describe, expect, test} from "bun:test";
import {Text} from "ink";
import {cleanup, render} from "ink-testing-library";
import {normalizeTerminalWidth, useTerminalWidth} from "../../src/ui/terminalSize.js";

afterEach(() => cleanup());

function WidthProbe() {
    return <Text>width:{useTerminalWidth()}</Text>;
}

describe("responsive terminal width", () => {
    test("resize 事件触发依赖列宽的组件重新渲染", async () => {
        const instance = render(<WidthProbe/>);
        let columns = 100;
        Object.defineProperty(instance.stdout, "columns", {
            configurable: true,
            get: () => columns,
        });
        instance.rerender(<WidthProbe/>);
        expect(instance.lastFrame()).toContain("width:100");

        columns = 52;
        instance.stdout.emit("resize");
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(instance.lastFrame()).toContain("width:52");
    });

    test("无有效 TTY 列宽时使用稳定默认值", () => {
        expect(normalizeTerminalWidth(undefined)).toBe(80);
        expect(normalizeTerminalWidth(0)).toBe(80);
        expect(normalizeTerminalWidth(47.8)).toBe(47);
    });
});
