import assert from "node:assert/strict";
import {Writable} from "node:stream";
import {useSyncExternalStore} from "react";
import {Box, Text, render} from "ink";
import {ScrollbackTranscript} from "../../src/ui/conversation/ScrollbackTranscript.js";
import {AssistantDraftView} from "../../src/ui/conversation/AssistantDraftView.js";
import {UITurnEventStore} from "../../src/ui/turn/eventStore.js";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";

const chunks: string[] = [];
const target = Object.assign(new Writable({write(chunk, _encoding, done) {chunks.push(String(chunk)); done();}}), {columns: 64, rows: 14, isTTY: true});
const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
const store = new UITurnEventStore();
const tick = () => new Promise(resolve => setTimeout(resolve, 110));
function Tree({expanded = false}: {expanded?: boolean}) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return <Box flexDirection="column"><ScrollbackTranscript threads={state.staticThreads} draftStore={store} expanded={expanded}/>
        <AssistantDraftView store={store}/><Text>❯ input</Text></Box>;
}
const app = render(<Tree/>, {stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false});
const clears = (parts: string[]) => parts.filter(part => part.includes("\x1b[2J")).length;
try {
    await tick();
    const start = chunks.length;
    let text = Array.from({length: 30}, (_, i) => `stream-row-${String(i).padStart(3, "0")}`).join("\n");
    store.handleEvent({type: "assistant_draft", responseId: "first", text, truncated: false});
    await tick();
    for (let i = 30; i < 34; i++) {
        text += `\nstream-row-${i}`;
        store.handleEvent({type: "assistant_draft", responseId: "first", text, truncated: false});
        await tick();
    }
    const growing = chunks.slice(start);
    assert.equal(clears(growing), 0, "streaming append must not repeatedly clear the screen");
    assert.equal(growing.join("").split("stream-row-000").length - 1, 1, "old draft rows must not be replayed per delta");
    assert(growing.join("").includes("stream-row-029"), "completed rows must remain in terminal history");
    const resizeStart = chunks.length;
    target.columns = 40; target.emit("resize");
    await tick();
    assert(chunks.slice(resizeStart).join("").includes("stream-row-000"), "resize must reflow retained draft source");
    const toggleStart = chunks.length;
    app.rerender(<Tree expanded/>);
    await tick();
    assert(chunks.slice(toggleStart).join("").includes("stream-row-000"));
    const resetStart = chunks.length;
    store.handleEvent({type: "assistant_draft_end", responseId: "first", disposition: "discarded"});
    await tick();
    assert.equal(clears(chunks.slice(resetStart)), 1, "retry must retract the old draft once");
    assert(!chunks.slice(resetStart).join("").includes("stream-row-000"));
    store.handleEvent({type: "assistant_draft", responseId: "second", text: "replacement first\nreplacement last", truncated: false});
    await tick();
    const commitStart = chunks.length;
    store.handleEvent({type: "assistant_draft_end", responseId: "second", disposition: "committed"});
    await tick();
    assert.equal(clears(chunks.slice(commitStart)), 0, "commit marker must not clear before final text arrives");
    store.handleEvent({type: "assistant_text", content: "replacement first\nreplacement last", phase: "final", responseId: "second"});
    await tick();
    assert.equal(clears(chunks.slice(commitStart)), 1, "final formatting replaces the draft once");
    assert.equal(store.getSnapshot().threads.filter(t => t.role === "assistant").length, 1);
    assert.equal(store.getDraftSnapshot(), null);
    const idleStart = chunks.length;
    app.rerender(<Tree expanded/>); await tick();
    assert.equal(clears(chunks.slice(idleStart)), 0, "idle rendering must not replay the finalized response");
} finally {app.unmount(); app.cleanup(); stdout.disposeCursorOutput();}
process.stdout.write("terminal-draft-ok\n");
