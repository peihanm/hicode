import {describe, expect, test} from "bun:test";
import stringWidth from "string-width";
import {createFileChange} from "../../src/fileChanges/index.js";
import type {UIThread} from "../../src/ui/conversation/types.js";
import {
    CLEAR_SCROLLBACK_AND_SCREEN,
    planTranscriptEmission,
    renderTranscriptForScrollback,
} from "../../src/ui/conversation/ScrollbackTranscript.js";

function cleanLines(value: string): string[] {
    return Bun.stripANSI(value).trimEnd().split("\n");
}

describe("source-backed terminal scrollback", () => {
    test("追加只写新条目，切换、resize 和正文变化重绘，动画不重绘", () => {
        const a: UIThread = {id: "a", role: "assistant", text: "Hello"};
        const b: UIThread = {id: "b", role: "assistant", text: "Next"};
        const initial = {width: 80, threads: [a], expanded: false};
        expect(planTranscriptEmission(undefined, initial, true)).toEqual({kind: "append", from: 0, includeWelcome: true});
        expect(planTranscriptEmission(initial, {...initial, threads: [a]}, true)).toEqual({kind: "none"});
        expect(planTranscriptEmission(initial, {...initial, expanded: true}, true)).toEqual({kind: "replay", includeWelcome: true});
        expect(planTranscriptEmission({...initial, expanded: true}, initial, true)).toEqual({kind: "replay", includeWelcome: true});
        expect(planTranscriptEmission(initial, {
            ...initial,
            threads: [a, b],
        }, true)).toEqual({kind: "append", from: 1, includeWelcome: false});
        expect(planTranscriptEmission(initial, {
            ...initial,
            width: 120,
        }, true)).toEqual({kind: "replay", includeWelcome: true});
        expect(planTranscriptEmission(initial, {
            ...initial,
            threads: [{...a, text: "Changed content with same ID"}],
        }, true)).toEqual({kind: "replay", includeWelcome: true});
        expect(CLEAR_SCROLLBACK_AND_SCREEN).toBe("\u001B[3J\u001B[2J\u001B[H");
    });

    test("同一 Assistant 源数据按新宽度重新生成物理行", async () => {
        const threads: UIThread[] = [{
            id: "assistant",
            role: "assistant",
            text: "使用方式：打开浏览器访问 http://127.0.0.1:8400，在编辑器里写 Solution.twoSum，点运行后展示每个用例的输入、输出和预期。",
        }];
        const narrow = cleanLines(await renderTranscriptForScrollback({
            threads,
            showWelcome: false,
            width: 40,
            height: 24,
        }));
        const wide = cleanLines(await renderTranscriptForScrollback({
            threads,
            showWelcome: false,
            width: 90,
            height: 24,
        }));

        expect(narrow.length).toBeGreaterThan(wide.length);
        expect(narrow.every((line) => stringWidth(line) <= 40)).toBe(true);
        expect(wide.every((line) => stringWidth(line) <= 90)).toBe(true);
        expect(narrow.join("").replace(/\s+/g, "")).toBe(
            wide.join("").replace(/\s+/g, "")
        );
    });

    test("Diff 在 replay 时按新宽度重算折行和行宽", async () => {
        const threads: UIThread[] = [{
            id: "changes",
            role: "file_change_group",
            turnId: "turn-1",
            changes: [createFileChange({
                path: "app.ts",
                kind: "update",
                oldContent: "const color = createTheme('red', 'legacy', 'high contrast');\n",
                newContent: "const color = createTheme('green', 'current', 'high contrast');\n",
            })],
        }];
        const narrowRaw = await renderTranscriptForScrollback({
            threads,
            showWelcome: false,
            width: 36,
            height: 24,
        });
        const wideRaw = await renderTranscriptForScrollback({
            threads,
            showWelcome: false,
            width: 72,
            height: 24,
        });
        const narrow = cleanLines(narrowRaw);
        const wide = cleanLines(wideRaw);
        const narrowDiff = narrow.filter((line) => /[+-] const color/.test(line));
        const wideDiff = wide.filter((line) => /[+-] const color/.test(line));

        expect(narrowDiff).toHaveLength(2);
        expect(wideDiff).toHaveLength(2);
        expect(narrow.length).toBeGreaterThan(wide.length);
        expect(narrowDiff.every((line) => stringWidth(line) <= 36)).toBe(true);
        expect(wideDiff.every((line) => stringWidth(line) <= 72)).toBe(true);
    });
});
