import assert from "node:assert/strict";
import {PassThrough, Writable} from "node:stream";
import {render} from "ink";
import {TerminalInputProvider} from "../../src/ui/input/terminalInput.js";
import {TerminalCursorAnchorProvider} from "../../src/ui/input/terminalCursorContext.js";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {TerminalScreen} from "../helpers/terminalScreen.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 140));
await withTempProject(async cwd => {
    const chunks: string[] = [];
    let screen = new TerminalScreen(80, 40);
    const target = Object.assign(new Writable({write(chunk, _encoding, done) {
        chunks.push(String(chunk)); screen.write(String(chunk)); done();
    }}), {columns: 80, rows: 40, isTTY: true});
    const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
    const input = Object.assign(new PassThrough(), {
        isTTY: true, setRawMode() {return this;}, ref() {return this;}, unref() {return this;},
    });
    const stdin = new Proxy(process.stdin, {get(object, property) {
        const source = property in input ? input : object;
        const value = Reflect.get(source, property, source);
        return typeof value === "function" ? value.bind(source) : value;
    }});
    const submitted: string[] = [];
    const resources = createTestRuntimeResources(cwd);
    const app = render(<TerminalInputProvider><TerminalCursorAnchorProvider enabled><AppForTest resources={resources}
        runAgentImpl={async (text, _history, emit) => {
            assert.equal(typeof text, "string");
            if (typeof text !== "string") throw new Error("Expected text input");
            submitted.push(text);
            await emit({type:"assistant_text",phase:"final",content:"HISTORY_MARKER"});
            return {reply:"done",reason:"completed",iterations:1};
        }}/></TerminalCursorAnchorProvider></TerminalInputProvider>,
        {stdout, stderr:stdout, stdin, patchConsole:false, exitOnCtrlC:false});
    try {
        await tick();
        assert.equal(chunks.join("").split("\x1b[?2004h").length - 1, 1);
        input.write("seed"); await tick(); input.write("\r"); await tick();
        const content = "中文 😀\r\n".repeat(22) + "last";
        input.write("\x1b[200~" + content.slice(0, 85)); await tick();
        input.write(content.slice(85)); await tick();
        assert.deepEqual(submitted, ["seed"], "paste contents must not trigger a model call");
        input.write("\x1b[201~"); await tick();
        for (const width of [40, 160, 40]) {
            screen = new TerminalScreen(width, 40);
            target.columns = width; target.emit("resize"); await tick(); await tick();
            const display = screen.allLines.join("\n");
            assert.equal(display.split("HISTORY_MARKER").length - 1, 1);
            assert(display.includes("[Pasted text #1 +22 lines]"));
            assert(!display.includes("#2"));
            assert(screen.lines[screen.cursor.y]?.startsWith("❯"), "cursor must stay in the prompt");
            assert.equal(chunks.join("").split("\x1b[?2004h").length - 1, 1, "resize must not reset terminal paste mode");
        }
        input.write("\r"); await tick();
        assert.deepEqual(submitted, ["seed", content.replaceAll("\r\n", "\n")]);
        const idle = chunks.length; await tick();
        assert.equal(chunks.length, idle, "idle input must not trigger redraws");
    } finally {
        app.unmount(); app.cleanup(); stdout.disposeCursorOutput(); input.destroy(); await resources.close();
    }
    assert.equal(chunks.join("").split("\x1b[?2004l").length - 1, 1, "unmount must disable bracketed paste");
});
process.stdout.write("terminal-paste-ok\n");
