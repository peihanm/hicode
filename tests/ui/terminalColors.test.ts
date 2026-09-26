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
    expect(plain).toContain("STATUS");
    expect(plain).toContain("- const value = 'old';");
    expect(plain).toContain("+ const value = 'new';");
    if (level < 2) {
        if (level === 0) expect(frame).not.toContain("\x1b[");
        else {
            for (const code of [41, 42, 46, 30]) expect(frame).toContain(`\x1b[${code}m`);
            expect(frame).toContain("\x1b[1m");
            expect(frame).not.toContain("\x1b[48;");
        }
    } else if (level === 3) {
        for (const color of ["243;244;246", "244;194;194", "183;228;199", "229;152;155", "116;198;157"]) {
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
