import assert from "node:assert/strict";
import {PassThrough, Writable} from "node:stream";
import {render} from "ink";
import type {AgentRunner} from "../../src/agent/index.js";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";
import {TerminalCursorAnchorProvider} from "../../src/ui/input/terminalCursorContext.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {TerminalScreen} from "../helpers/terminalScreen.js";

const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
const cases = [[24, "allow"], [35, "allow"], [50, "allow"], [35, "deny"]] as const;
for (const [height, answer] of cases) {
    await withTempProject(async cwd => {
        const chunks: string[] = [];
        const screen = new TerminalScreen(100, height);
        const target = Object.assign(new Writable({write(chunk, _encoding, done) {
            chunks.push(String(chunk));
            screen.write(String(chunk));
            done();
        }}), {columns: 100, rows: height, isTTY: true});
        const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
        const input = Object.assign(new PassThrough(), {
            isTTY: true, setRawMode() {return this;}, ref() {return this;}, unref() {return this;},
        });
        const stdin = new Proxy(process.stdin, {get(object, property) {
            const source = property in input ? input : object;
            const value = Reflect.get(source, property, source);
            return typeof value === "function" ? value.bind(source) : value;
        }});
        const resources = createTestRuntimeResources(cwd);
        let release!: () => void, ready!: () => void, permitted!: () => void;
        const gate = new Promise<void>(resolve => {release = resolve;});
        const started = new Promise<void>(resolve => {ready = resolve;});
        const allowed = new Promise<void>(resolve => {permitted = resolve;});
        const runner: AgentRunner = async (_input, _history, emit, ctx) => {
            await ctx.setTodos(Array.from({length: 5}, (_, index) => ({
                content: `Stage ${index}`, activeForm: `Stage ${index}`,
                status: index ? "pending" as const : "in_progress" as const,
            })));
            await emit({type: "tool_call_start", turnId: "turn", toolCallId: "write",
                name: "write_file", args: '{"path":"package.json","content":"..."}'});
            await emit({type: "tool_call_end", turnId: "turn", toolCallId: "write", outcome: "ok", result: "created",
                uiData: {type: "file_change", change: {
                    version: 1, path: "package.json", kind: "create", linesAdded: 17, linesRemoved: 0, diffStatus: "complete",
                    hunks: [{oldStart: 0, oldLines: 0, newStart: 1, newLines: 17,
                        lines: Array.from({length: 17}, (_, index) => ({type: "add" as const,
                            content: index === 16 ? "CODE_END" : `Code line ${index} 浏览器任务看板`, newLineNumber: index + 1}))}],
                }}});
            await tick(50);
            await emit({type: "iteration", current: 2});
            await emit({type: "assistant_text", phase: "commentary", content: "AFTER_CODE install dependencies now"});
            await emit({type: "tool_call_start", turnId: "turn", toolCallId: "bash",
                name: "bash", args: '{"command":"bun install && bun run build"}'});
            ready();
            // Exercise the real permission host and Ink dialog, without running a command or making a network request.
            const decision = await ctx.canUseTool("bash", "network", {}, {
                allowPersistent: false, presentation: {kind: "network_access", host: "registry.npmjs.org", port: 443},
            });
            await emit({type: "tool_call_end", turnId: "turn", toolCallId: "bash",
                outcome: decision.behavior === "allow" ? "ok" : "denied",
                result: decision.behavior === "allow" ? "Resolving dependencies" : "User denied network access"});
            permitted();
            await gate;
            return {reply: "done", reason: "completed", iterations: 2};
        };
        const app = render(
            <TerminalCursorAnchorProvider enabled><AppForTest resources={resources} runAgentImpl={runner}/></TerminalCursorAnchorProvider>,
            {stdout, stderr: stdout, stdin, patchConsole: false, exitOnCtrlC: false}
        );
        try {
            await tick(); input.write("build"); await tick(); input.write("\r");
            await started; await tick(300);
            input.write("\x1b[B"); await tick();
            const offset = chunks.length;
            input.write(answer === "allow" ? "\r" : "3");
            await allowed; await tick(400);
            const closed = chunks.slice(offset);
            assert.equal(closed.filter(chunk => chunk.includes("\x1b[3J\x1b[2J\x1b[H")).length, 1,
                "permission dismissal must reestablish the transcript boundary exactly once");
            const lines = screen.lines;
            const end = lines.findIndex(line => line.includes("CODE_END"));
            const after = lines.findIndex(line => line.includes("AFTER_CODE"));
            assert(end >= 0 && after > end && after - end <= 3,
                `height=${height},answer=${answer},gap=${after - end}\n${lines.map((line, index) => `${index}: ${line}`).join("\n")}`);
            assert(!lines.some(line => line.includes("NETWORK ACCESS")), "closed permission rows must disappear");
            assert(lines[screen.cursor.y]?.startsWith("❯"), `cursor must return to prompt: height=${height},answer=${answer},cursor=${JSON.stringify(screen.cursor)},line=${JSON.stringify(lines[screen.cursor.y])}\n${lines.join("\n")}`);
            if (answer === "deny") assert(lines.some(line => line.includes("User denied network access")));
            const clearCount = chunks.filter(chunk => chunk.includes("\x1b[2J")).length;
            await tick(300);
            assert.equal(chunks.filter(chunk => chunk.includes("\x1b[2J")).length, clearCount,
                "animation must not replay the transcript");
        } finally {
            release(); await tick(); app.unmount(); app.cleanup();
            stdout.disposeCursorOutput(); input.destroy(); await resources.close();
        }
    });
}
process.stdout.write("permission-app-ok\n");
