import assert from "node:assert/strict";
import {Writable} from "node:stream";
import {Box, Text, render} from "ink";
import {ScrollbackTranscript} from "../../src/ui/conversation/ScrollbackTranscript.js";
import {createTerminalCursorOutput, TERMINAL_CURSOR_ANCHOR_MARKER, TERMINAL_CURSOR_ANCHOR_END} from "../../src/ui/input/terminalCursor.js";
import type {UIThread} from "../../src/ui/conversation/types.js";
import {TerminalScreen} from "../helpers/terminalScreen.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 130));
for (const historySize of [2, 70]) {
    const chunks: string[] = [];
    const screen = new TerminalScreen(80, 30);
    const target = Object.assign(new Writable({write(chunk, _encoding, done) {
        const text = String(chunk); chunks.push(text); screen.write(text); done();
    }}), {columns: 80, rows: 30, isTTY: true});
    const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
    const threads: UIThread[] = [{id: "history", role: "assistant", text: Array.from({length: historySize}, (_, i) => `History line ${i}`).join("\n")}];
    const tree = (lines: number, typed = "") => <Box flexDirection="column">
        <ScrollbackTranscript threads={threads}/>
        {Array.from({length: lines}, (_, i) => <Text key={i}>{`Task panel row ${i}`}</Text>)}
        <Text>{`Input ${typed}${TERMINAL_CURSOR_ANCHOR_MARKER} ${TERMINAL_CURSOR_ANCHOR_END}`}</Text>
        <Text>FOOTER</Text>
    </Box>;
    const app = render(tree(0), {stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false});
    try {
        await tick();
        for (const size of [18, 8, 0]) {
            app.rerender(tree(size)); await tick();
            const footer = screen.lines.findIndex(line => line === "FOOTER");
            if (historySize === 70) assert(footer >= 28, `Footer floats at row ${footer} after ${size} live rows\n${screen.lines.join("\n")}`);
            else assert(!chunks.join("").includes("\x1b[2J"), "short history should keep natural top layout without clearing");
        }
        assert(!screen.lines.join("\n").includes("Task panel row"), "closed panel must leave no stale lines");
        const count = chunks.filter(chunk => chunk.includes("\x1b[2J")).length;
        app.rerender(tree(0, "typed")); await tick();
        assert.equal(chunks.filter(chunk => chunk.includes("\x1b[2J")).length, count, "same-height input updates must not clear the screen");
        assert.equal(screen.cursor.y, screen.lines.findIndex(line => line.startsWith("Input typed")), "IME cursor remains on the input");
        assert(!chunks.join("").includes("hicode-cursor://"));
    } finally {app.unmount(); app.cleanup(); stdout.disposeCursorOutput();}
}
process.stdout.write("terminal-shrink-ok\n");
