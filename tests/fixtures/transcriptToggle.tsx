import assert from "node:assert/strict";
import {PassThrough, Writable} from "node:stream";
import {render} from "ink";
import type {AgentRunner} from "../../src/agent/index.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";
import {TerminalCursorAnchorProvider} from "../../src/ui/input/terminalCursorContext.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";

// Run in a fresh process with CI=0: Ink chooses its real terminal renderer at import time.
const tick = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
const clears = (chunks: string[]) => chunks.filter(chunk => chunk.includes("\x1b[2J")).length;
const sourceReplays = (chunks: string[]) => chunks.filter(chunk => chunk.includes("\x1b[3J\x1b[2J\x1b[H")).length;
await withTempProject(async cwd => {
    const chunks: string[] = [];
    const target = Object.assign(new Writable({write(chunk, _encoding, done) {
        chunks.push(String(chunk)); done();
    }}), {columns: 100, rows: 30, isTTY: true});
    const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
    const input = Object.assign(new PassThrough(), {
        isTTY: true, setRawMode() {return this;}, ref() {return this;}, unref() {return this;},
    });
    const stdin = new Proxy(process.stdin, {get(target, property) {
        const source = property in input ? input : target;
        const value = Reflect.get(source, property, source);
        return typeof value === "function" ? value.bind(source) : value;
    }});
    const resources = createTestRuntimeResources(cwd);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    let ready!: () => void;
    const started = new Promise<void>(resolve => {ready = resolve;});
    let emit!: (event: AgentEvent) => void;
    const read = (id: string) => {
        emit({type: "tool_call_start", turnId: "turn", toolCallId: id,
            name: "read_file", args: JSON.stringify({path: `${id}.ts`})});
        emit({type: "tool_call_end", turnId: "turn", toolCallId: id, outcome: "ok",
            result: Array.from({length: 90}, (_,i) => `${id}-DETAIL-${i}`).join("\n")});
    };
    const runner: AgentRunner = async (_input, _history, onEvent) => {
        emit = onEvent;
        read("first");
        emit({type: "model_stream_start"});
        emit({type: "model_stream_progress", phase: "tool_input", toolName: "write_file",
            outputCharacters: 100, estimatedOutputTokens: 25});
        ready();
        await gate;
        return {reply: "done", reason: "completed", iterations: 1};
    };
    const app = render(
        <TerminalCursorAnchorProvider enabled>
            <AppForTest resources={resources} runAgentImpl={runner}/>
        </TerminalCursorAnchorProvider>,
        {stdout, stderr: stdout, stdin, patchConsole: false, exitOnCtrlC: false}
    );
    try {
        await tick(); input.write("inspect"); await tick(); input.write("\r");
        await started; await tick();
        let offset = chunks.length;
        input.write("\x0f"); await tick(600);
        const expanded = chunks.slice(offset);
        assert.equal(sourceReplays(expanded), 1, "expand must render history only once despite animation ticks");
        assert(clears(expanded) <= 2, "at most one additional live-height refill");
        assert.equal(expanded.filter(chunk => chunk.includes("first-DETAIL-80")).length, 1);

        offset = chunks.length;
        read("second"); await tick(300);
        const appended = chunks.slice(offset).join("");
        // The completed tool also removes its live progress rows. A scrolled
        // viewport may refill once for that shrink, but never on animation ticks.
        assert(clears(chunks.slice(offset)) <= 1, "a result may refill once when live progress shrinks");
        assert(appended.includes("second-DETAIL-80"));
        if (clears(chunks.slice(offset))) {
            const refill = appended.slice(appended.lastIndexOf("\x1b[2J"));
            assert(refill.includes("first-DETAIL-80") && refill.includes("second-DETAIL-80"));
        } else assert(!appended.includes("first-DETAIL-80"));
        offset = chunks.length;
        await tick(250);
        assert.equal(clears(chunks.slice(offset)), 0, "same-height animation never refills history");

        offset = chunks.length;
        target.rows = 35; target.emit("resize"); await tick(250);
        assert.equal(clears(chunks.slice(offset)), 0, "height-only resize does not replay");
        offset = chunks.length;
        target.columns = 90; target.emit("resize"); await tick(300);
        assert.equal(sourceReplays(chunks.slice(offset)), 1, "width resize renders history once");
        assert(clears(chunks.slice(offset)) <= 2, "footer reflow may refill once after width changes");
        assert(chunks.slice(offset).join("").includes("second-DETAIL-80"));

        offset = chunks.length;
        input.write("\x0f"); await tick(400);
        const collapsed = chunks.slice(offset);
        assert.equal(sourceReplays(collapsed), 1, "collapse must erase expanded physical history");
        assert(clears(collapsed) <= 2, "collapse may also refill a shrinking live region once");
        assert(!collapsed.join("").includes("DETAIL-80"));

        offset = chunks.length;
        input.write("\x0f"); await tick(10); input.write("\x0f"); await tick(10); input.write("\x0f");
        read("third"); await tick(400);
        const latest = chunks.slice(offset).join("");
        const replay = latest.slice(latest.lastIndexOf("\x1b[3J"));
        assert(replay.includes("first-DETAIL-80"));
        assert(replay.includes("second-DETAIL-80"));
        assert(replay.includes("third-DETAIL-80"), "rapid toggles must not lose an incoming result");
        input.write("\x0f"); await tick(250);
        input.write("next"); await tick();
        const inputFrame = chunks.findLast(chunk => chunk.includes("❯ next"));
        assert(inputFrame, "input remains usable after toggling and resize");
        assert.match(inputFrame, /\x1b7\x1b\[4A\x1b\[7G$/);
        assert(!chunks.join("").includes("hicode-cursor://"));
        stdout.write("\x1b[2J\x1b[3J\x1b[Hoverflow dialog");
        assert(chunks.at(-1)?.includes("❯ inspect"), "overflow retains the committed history");
        assert(!chunks.at(-1)?.includes("DETAIL-80"), "overflow cannot resurrect expanded history");
    } finally {
        release(); await tick(); app.unmount(); app.cleanup();
        stdout.disposeCursorOutput(); await resources.close(); input.destroy();
    }
});
process.stdout.write("transcript-toggle-ok\n");
