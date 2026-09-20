import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {InputBox} from "../../src/ui/input/InputBox.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {FileSuggestionResult} from "../../src/runtime/fileSuggestions.js";

afterEach(cleanup);
const tick = () => new Promise(resolve => setTimeout(resolve, 100));

test("Enter inserts a path before submission; narrow menus and image labels stay intact", async () => {
    const submitted: string[] = [];
    const source = {search: async () => ({paths: ["src/InputBox.tsx", "src/中文 file.ts"], limited: false}), cancel() {}};
    const view = render(<InputBox disabled={false} terminalWidth={42} imageCount={1} fileSuggestions={source} onSubmit={value => submitted.push(value)}/>);
    await tick();
    view.stdin.write("check @input");
    await tick();
    expect(view.lastFrame()).toContain("› InputBox.tsx");
    view.stdin.write("\u001b"); await tick();
    expect(view.lastFrame()).not.toContain("Esc close");
    view.stdin.write("x"); await tick();
    view.stdin.write("\u007f"); await tick();
    expect(view.lastFrame()).toContain("› InputBox.tsx");
    view.stdin.write("\u001b[B");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(submitted).toEqual([]);
    expect(view.lastFrame()).toContain('[Image #1] check "src/中文 file.ts"');
    expect(view.lastFrame()).not.toContain("Esc close");
    view.stdin.write("\r");
    await tick();
    expect(submitted).toEqual(['check "src/中文 file.ts"']);
});

test("completion uses the real cursor, replaces a middle token and supports a second mention", async () => {
    const submitted: string[] = [];
    const source = {search: async () => ({paths: ["src/one.ts"], limited: false}), cancel() {}};
    const view = render(<InputBox disabled={false} terminalWidth={80} fileSuggestions={source} onSubmit={value => submitted.push(value)}/>);
    await tick();
    view.stdin.write("check @one later");
    await tick();
    for (let i = 0; i < 6; i++) view.stdin.write("\u001b[D");
    await tick();
    view.stdin.write("\t");
    await tick();
    expect(view.lastFrame()).toContain("check src/one.ts later");
    for (let i = 0; i < 6; i++) view.stdin.write("\u001b[C");
    view.stdin.write(" @one");
    await tick();
    view.stdin.write("\r");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(submitted).toEqual(["check src/one.ts later src/one.ts"]);
});

test("pending and stale file searches cannot submit a draft or replace newer results", async () => {
    const pending = new Map<string, (value: FileSuggestionResult) => void>();
    const submitted: string[] = [];
    const source = {search: (query: string) => new Promise<FileSuggestionResult>(resolve => pending.set(query, resolve)), cancel() {}};
    const view = render(<InputBox disabled={false} terminalWidth={80} fileSuggestions={source} onSubmit={value => submitted.push(value)}/>);
    await tick();
    view.stdin.write("@a");
    await tick();
    view.stdin.write("\r");
    expect(submitted).toEqual([]);
    view.stdin.write("b");
    await tick();
    pending.get("ab")!({paths: ["ab.ts"], limited: false});
    await tick();
    pending.get("a")!({paths: ["STALE.ts"], limited: false});
    await tick();
    expect(view.lastFrame()).toContain("ab.ts");
    expect(view.lastFrame()).not.toContain("STALE.ts");
    view.stdin.write("\u001b");
    await tick();
    expect(view.lastFrame()).not.toContain("Esc close");
    view.stdin.write("\r");
    await tick();
    expect(submitted).toEqual(["@ab"]);
});

test("App routes Escape to file suggestions before cancelling an active Agent; enumeration stays out of the transcript", async () => {
    await withTempProject(async cwd => {
        await mkdir(join(cwd, "src"));
        await writeFile(join(cwd, "src/InputBox.tsx"), "SOURCE_BODY_SENTINEL");
        let cancelled = false;
        let started!: () => void;
        const running = new Promise<void>(resolve => {started = resolve;});
        const view = render(<AppForTest resources={createTestRuntimeResources(cwd, {workspaceBoundary: "/"})} runAgentImpl={async (_input, _history, _event, ctx) => {
            started();
            await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => {cancelled = true; resolve();}, {once: true}));
            return {reply: "", reason: "interrupted", iterations: 1};
        }}/>);
        await tick(); view.stdin.write("work"); await tick(); view.stdin.write("\r");
        await running;
        view.stdin.write("@input");
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(view.lastFrame()).toMatch(/InputBox\.tsx\s+src\//);
        expect(view.lastFrame()).not.toContain("SOURCE_BODY_SENTINEL");
        expect(view.frames.join("\n")).not.toContain("● Bash rg");
        view.stdin.write("\u001b"); await tick();
        expect(cancelled).toBe(false);
        expect(view.lastFrame()).not.toContain("Esc close");
        view.stdin.write("\u001b"); await tick();
        expect(cancelled).toBe(true);
    });
});

test("file suggestions separate names and directories while selecting the full relative path", async () => {
    const submitted: string[] = [];
    const source = {search: async () => ({paths: ["index.html", "client/index.ts", "server/index.ts", "源码/中文.ts"], limited: false}), cancel() {}};
    const props = {disabled: false, fileSuggestions: source, onSubmit: (value: string) => submitted.push(value)};
    const view = render(<InputBox {...props} terminalWidth={65}/>);
    await tick(); view.stdin.write("@"); await tick();
    const frame = view.lastFrame() ?? "";
    expect(frame).toMatch(/index\.html\s+\.\//);
    expect(frame).toMatch(/index\.ts\s+client\//);
    expect(frame).toMatch(/index\.ts\s+server\//);
    expect(frame).toMatch(/中文\.ts\s+源码\//);
    view.rerender(<InputBox {...props} terminalWidth={24}/>);
    await tick();
    expect(view.lastFrame()).toMatch(/index\.ts\s+server\//);
    view.stdin.write("\u001b[B"); view.stdin.write("\u001b[B");
    view.stdin.write("\r"); await tick(); view.stdin.write("\r"); await tick();
    expect(submitted).toEqual(["server/index.ts"]);
});
