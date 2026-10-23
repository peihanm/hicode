import assert from "node:assert/strict";
import {Writable} from "node:stream";
import {Box, Text, render} from "ink";
import {createFileChange} from "../../src/fileChanges/index.js";
import {ScrollbackTranscript} from "../../src/ui/conversation/ScrollbackTranscript.js";
import type {UIThread} from "../../src/ui/conversation/types.js";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";

const chunks: string[] = [];
const target = Object.assign(new Writable({write(chunk, _encoding, done) {
    chunks.push(String(chunk)); done();
}}), {columns: 80, rows: 24, isTTY: true});
const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
const threads: UIThread[] = [{
    id: "diff", role: "file_change_group", turnId: "turn",
    changes: [createFileChange({
        path: "package.json", kind: "create", oldContent: "",
        newContent: "{\n  \"name\": \"demo\"\n}\n",
    })],
}];
const tick = () => new Promise(resolve => setTimeout(resolve, 120));
const tree = (live: string) => <Box flexDirection="column">
    <ScrollbackTranscript threads={threads}/>
    <Text>{live}</Text>
</Box>;
const app = render(tree("\nWaiting\n❯ input"), {
    stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false,
});
try {
    await tick();
    app.rerender(tree(Array.from({length: 30}, (_, i) => `old live row ${i}`).join("\n")));
    await tick();
    assert(chunks.at(-1)?.includes("\x1b[2J"), "fixture must exercise Ink's overflow branch");
    const offset = chunks.length;
    app.rerender(tree("\n● Bash npm install\n❯ input"));
    await tick();
    const recovered = chunks.slice(offset);
    assert.equal(recovered.filter(chunk => chunk.includes("\x1b[2J")).length, 1,
        "leaving overflow must remove stale live rows, including those in scrollback");
    const frame = Bun.stripANSI(recovered.join(""));
    assert.match(frame, /3 \+ }[ \t]*\n\n● Bash npm install\n❯ input/);
    assert.equal(frame.match(/● Building/g)?.length, 1);
    assert(!frame.includes("old live row"));

    const nextOffset = chunks.length;
    app.rerender(tree("\n● Bash npm install\n❯ next"));
    await tick();
    assert(!chunks.slice(nextOffset).join("").includes("\x1b[2J"),
        "ordinary input and animation updates must resume incremental rendering");
} finally {
    app.unmount(); app.cleanup(); stdout.disposeCursorOutput();
}
process.stdout.write("terminal-overflow-ok\n");
