import {expect, test} from "bun:test";
import {fileURLToPath} from "node:url";

for (const level of [0, 1, 2, 3]) test(`status and diff remain readable at color level ${level}`, async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/terminalColors.tsx", import.meta.url))], {
        env: {PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: level >= 2 ? "xterm-256color" : "xterm",
            ...(level === 3 ? {COLORTERM: "truecolor"} : {}), FORCE_COLOR: String(level)},
        stdout: "pipe", stderr: "pipe",
    });
    const [code, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const frame: unknown = JSON.parse(output);
    if (typeof frame !== "string") throw new Error("Missing terminal frame");
    const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
    // 底部提示栏只着色文字，不再铺浅色底，避免深色终端上出现白条。
    expect(frame).not.toContain("\x1b[48;2;243;244;246m");
    if (level === 1) expect(frame).not.toContain("\x1b[46m");
    expect(plain).toContain("STATUS");
    expect(plain).toContain("- const value = 'old';");
    expect(plain).toContain("+ const value = 'new';");
    if (level < 2) {
        if (level === 0) expect(frame).not.toContain("\x1b[");
        else {
            for (const code of [41, 42, 30]) expect(frame).toContain(`\x1b[${code}m`);
            expect(frame).toContain("\x1b[1m");
            expect(frame).not.toContain("\x1b[48;");
        }
    } else if (level === 3) {
        for (const color of ["244;194;194", "183;228;199", "229;152;155", "116;198;157"]) {
            expect(frame).toContain(`\x1b[48;2;${color}m`);
        }
    } else {
        expect(frame).toContain("\x1b[48;5;");
        expect(frame).not.toContain("\x1b[48;2;");
        // Quantized additions and removals must not collapse to the same background.
        const backgrounds = new Set([...frame.matchAll(/\x1b\[48;5;(\d+)m/g)].map(match => match[1]));
        expect(backgrounds.size).toBeGreaterThanOrEqual(3);
    }
}, 10000);

test("nonzero command exit is neutral while tool and task runtime failures stay red", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/failedToolColors.tsx", import.meta.url))], {
        env: {PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm", FORCE_COLOR: "1"},
        stdout: "pipe", stderr: "pipe",
    });
    const [code, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const frames: Record<string, {normal: string; transcript: string}> = JSON.parse(output);
    for (const [id, expectedColor] of Object.entries({exit: 90, signal: 33, timeout: 33, cancelled: 90,
        spawn: 31, outputLimit: 31, delivery: 31, unknown: 31})) {
        for (const frame of Object.values(frames[id]!)) {
            expect(frame).toContain(`\x1b[${expectedColor}m⎿\x1b[39m`);
            expect(frame).toContain(`\x1b[${expectedColor}m●`);
            if (expectedColor !== 31) expect(frame).not.toContain("\x1b[31m");
            expect(frame).toContain("Command exited with code 1");
            expect(frame).toContain("\x1b[90mFAILED example.py::test_case\x1b[39m");
        }
    }
}, 10000);
