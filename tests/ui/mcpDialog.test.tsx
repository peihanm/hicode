import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {z} from "zod";
import stringWidth from "string-width";
import {McpDialog} from "../../src/ui/mcp/McpDialog.js";
import {ConfirmDialog} from "../../src/ui/dialogs/ConfirmDialog.js";
import type {McpManagerLike, McpToolPolicy} from "../../src/mcp/types.js";
import type {Tool} from "../../src/tools/types.js";
import type {PermissionRules} from "../../src/permissions/types.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

afterEach(cleanup);
const tick = () => new Promise(resolve => setTimeout(resolve, 35));
const name = (suffix: string) => `mcp__fixture__${suffix}`;
const empty = (): PermissionRules => ({allow: [], ask: [], deny: []});
function fixture(suffixes: string[]) {
    let tools: readonly Tool[] = suffixes.map(suffix => ({name: name(suffix), description: `Execute ${suffix}`,
        parameters: z.object({}), searchSource: {name: "fixture"},
        isReadOnly: () => suffix === "read", async execute() {return "ok";}}));
    const listeners = new Set<() => void>();
    let reconnects = 0, policy: McpToolPolicy | undefined;
    const saved: McpToolPolicy[] = [];
    const manager: McpManagerLike = {
        async initialize() {}, async closeAll() {}, async reconnect() {reconnects++;},
        async setToolPolicy(server, hash, value) {
            expect(server).toBe("fixture"); expect(hash).toBe("a".repeat(64));
            policy = structuredClone(value); saved.push(policy); listeners.forEach(listener => listener());
        },
        getTools: () => tools,
        getSnapshots: () => [{name: "fixture", source: "project", status: "connected", toolCount: tools.length, configHash: "a".repeat(64), toolPolicy: policy}],
        subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    };
    return {manager, saved, get reconnects() {return reconnects;}, replace() {
        tools = tools.map(tool => ({...tool, description: "changed"})); listeners.forEach(listener => listener());
    }};
}

test("service default and exceptions save together; stronger settings are retained", async () => {
    const f = fixture(["execute", "read", "blocked"]), rules = empty();
    rules.deny = [{source: "local", toolName: name("blocked")}];
    let closed = 0;
    const view = render(<McpDialog manager={f.manager} getRules={() => rules} onSave={f.manager.setToolPolicy} onClose={() => closed++}/>);
    const key = async (input: string) => {view.stdin.write(input); await tick();};
    await tick(); await key("\r"); expect(f.saved).toEqual([]);
    await key(" "); expect(view.lastFrame()).toContain("Default: Allow tools");
    await key("\u001b[B"); await key(" "); // execute -> ask
    await key("\u001b[B"); await key(" "); await key(" "); // readonly -> deny
    await key("\u001b[B"); await key(" "); // locked settings deny
    expect(f.saved).toEqual([]); await key("\r");
    expect(f.saved).toEqual([{default: "allow", exceptions: {[name("execute")]: "ask", [name("read")]: "deny"}}]);
    expect(view.lastFrame()).toContain("Saved for this project");
    expect(view.lastFrame()).not.toContain("changed. Esc");
    await key("\u001b"); expect(closed).toBe(0); await key("r"); expect(f.reconnects).toBe(1);
    await key("\u001b"); expect(closed).toBe(1);
});

test("save failures preserve draft and catalog changes prevent stale grants", async () => {
    const f = fixture(["execute"]); let saves = 0;
    const view = render(<McpDialog manager={f.manager} getRules={empty} onSave={async () => {saves++; throw Error("disk unavailable");}} onClose={() => {}}/>);
    await tick(); view.stdin.write("\r"); await tick(); view.stdin.write(" "); await tick(); view.stdin.write("\r"); await tick();
    expect(saves).toBe(1); expect(view.lastFrame()).toContain("disk unavailable");
    expect(view.lastFrame()).toContain("Default: Allow tools"); expect(view.lastFrame()).not.toContain("Saved for");
    f.replace(); await tick(); expect(view.lastFrame()).toContain("Connection or tools changed");
    view.stdin.write("\r"); await tick(); expect(saves).toBe(1);
});

test("long tool lists scroll in a narrow terminal", async () => {
    const f = fixture(Array.from({length: 18}, (_, index) => `tool${index}`));
    const view = render(<McpDialog manager={f.manager} getRules={empty} onSave={f.manager.setToolPolicy} onClose={() => {}}/>);
    Object.defineProperty(view.stdout, "columns", {configurable: true, value: 36});
    Object.defineProperty(view.stdout, "rows", {configurable: true, value: 24});
    view.stdout.emit("resize"); await new Promise(resolve => setTimeout(resolve, 110));
    view.stdin.write("\r"); await tick();
    for (let i = 0; i < 18; i++) {view.stdin.write("\u001b[B"); await tick();}
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("tool17"); expect(frame).toContain("18 / 18");
    expect(frame.split("\n").every(line => stringWidth(line) <= 36)).toBe(true);
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
});

test("/mcp opens and saves policy locally without model work", async () => withTempProject(async cwd => {
    const f = fixture(["execute"]);
    const resources = createTestRuntimeResources(cwd, {mcpManager: f.manager}); let calls = 0;
    const view = render(<AppForTest resources={resources} runAgentImpl={async () => {
        calls++; return {reply: "unexpected", reason: "completed", iterations: 1};
    }}/>);
    try {
        await tick(); view.stdin.write("/mcp"); await tick(); view.stdin.write("\r"); await tick();
        expect(view.lastFrame()).toContain("◆ MCP"); expect(view.lastFrame()).not.toContain("Worked for");
        view.stdin.write("\r"); await tick(); view.stdin.write(" "); await tick(); view.stdin.write("\r"); await tick();
        expect(f.saved).toEqual([{default: "allow", exceptions: {}}]);
        view.stdin.write("\u001b"); await tick(); view.stdin.write("\u001b"); await tick();
        expect(view.lastFrame()).toContain("Ask HiCode"); expect(calls).toBe(0);
    } finally {view.unmount(); await resources.close();}
}));

test("MCP confirmation explains persistent approval scope", async () => {
    const saved: string[] = []; let allowed = false;
    const view = render(<ConfirmDialog req={{id: 1, toolName: name("execute"), question: "Approve execution",
        input: {code: "print('first')"}, resolve: decision => {allowed = decision.behavior === "allow";}}}
        onDone={() => {}} onAddToAllowList={async rule => {saved.push(rule);}}/>);
    await tick(); expect(view.lastFrame()).toContain("Always allow this tool in this project");
    expect(view.lastFrame()).toContain("all arguments");
    view.stdin.write("2"); await tick(); expect(allowed).toBe(true); expect(saved).toEqual([name("execute")]);
});

test("Ctrl+C closes /mcp from details without saving or exiting the conversation", async () => withTempProject(async cwd => {
    const f = fixture(["execute"]);
    const resources = createTestRuntimeResources(cwd, {mcpManager: f.manager}); let calls = 0;
    const view = render(<AppForTest resources={resources} runAgentImpl={async () => {
        calls++; return {reply: "still running", reason: "completed", iterations: 1};
    }}/>);
    const key = async (value: string) => {view.stdin.write(value); await tick();};
    try {
        await tick(); await key("/mcp"); await key("\r"); await key("\r"); await key(" ");
        expect(view.lastFrame()).toContain("Default: Allow tools");
        expect(view.lastFrame()).toContain("Ctrl+C close");
        expect(view.lastFrame()?.split("◆ MCP").at(-1)).not.toContain("shift+tab");
        expect(view.lastFrame()).not.toContain("mcp__fixture__execute");
        await key("\x03");
        expect(view.lastFrame()).toContain("Ask HiCode"); expect(view.lastFrame()).not.toContain("◆ MCP");
        expect(f.saved).toEqual([]);
        await key("hello"); await key("\r"); expect(calls).toBe(1);
    } finally {view.unmount(); await resources.close();}
}));

test("Ctrl+C also closes while a save is pending; it does not claim to undo the save", async () => {
    const f = fixture(["execute"]); let finish!: () => void; let closed = 0;
    const pending = new Promise<void>(resolve => {finish = resolve;});
    const view = render(<McpDialog manager={f.manager} getRules={empty} onSave={() => pending} onClose={() => closed++}/>);
    await tick(); view.stdin.write("\r"); await tick(); view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("Saving or reconnecting");
    view.stdin.write("\x03"); await tick(); expect(closed).toBe(1);
    view.unmount(); finish(); await tick();
});
