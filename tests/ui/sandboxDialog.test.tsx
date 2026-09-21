import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {SandboxDialog} from "../../src/ui/sandbox/SandboxDialog.js";
import stringWidth from "string-width";
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
afterEach(cleanup);

test("network policy selection is explicit, saves on Enter and explains restart", async () => {
    const saved: string[] = []; let closed = false;
    const view = render(<SandboxDialog status={{kind: "ready", platform: "macos", networkMode: "restricted", warnings: []}}
        configured="restricted" fullAccess={false} onSave={async mode => {saved.push(mode);}} onClose={() => {closed = true;}}/>);
    await tick();
    expect(view.lastFrame()).toContain("Active: Restricted");
    expect(saved).toEqual([]);
    view.stdin.write("\u001b[B"); await tick();
    expect(saved).toEqual([]);
    view.stdin.write("\r"); await tick();
    expect(saved).toEqual(["open"]);
    expect(view.lastFrame()).toContain("✓ Saved · Open");
    expect(view.lastFrame()).toContain("Restart HiCode");
    expect(view.lastFrame()).toContain("filesystem isolation enabled");
    view.stdin.write("\u001b"); await tick(); expect(closed).toBe(true);
});

test("failed save stays visible and never claims the policy was changed", async () => {
    const view = render(<SandboxDialog status={{kind: "ready", platform: "macos", networkMode: "restricted", warnings: []}}
        configured="restricted" fullAccess={true} onSave={async () => {throw new Error("settings are corrupt");}} onClose={() => {}}/>);
    await tick(); view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("Full Access is active");
    expect(view.lastFrame()).toContain("settings are corrupt");
    expect(view.lastFrame()).not.toContain("✓ Saved");
});

test("saving the active policy shows one confirmation without a restart warning", async () => {
    const view = render(<SandboxDialog status={{kind: "ready", platform: "macos", networkMode: "open", warnings: []}}
        configured="open" fullAccess={false} onSave={async () => {}} onClose={() => {}}/>);
    await tick(); view.stdin.write("\r"); await tick();
    const frame = view.lastFrame()!;
    expect(frame.match(/Saved/g)).toHaveLength(1);
    expect(frame).not.toContain("Restart HiCode");
    expect(frame).toContain("Open  · configured");
    expect(frame).toMatch(/settings.local.json\n\s*\n\s*↑↓ select/);
});

test("narrow terminal wraps option descriptions with a consistent indent and resizes cleanly", async () => {
    const view = render(<SandboxDialog status={{kind: "ready", platform: "macos", networkMode: "open", warnings: []}}
        configured="open" fullAccess={false} onSave={async () => {}} onClose={() => {}}/>);
    let columns = 42;
    Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
    view.stdout.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 110));
    const narrow = view.lastFrame()!;
    for (const line of narrow.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    expect(narrow).toMatch(/     Allow internet and local network\n     access without prompts\./);
    columns = 100;
    view.stdout.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(view.lastFrame()).toContain("Allow internet and local network access without prompts.");
});
