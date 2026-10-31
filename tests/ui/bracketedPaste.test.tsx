import {afterEach, describe, expect, test} from "bun:test";
import {useState} from "react";
import {cleanup, render} from "ink-testing-library";
import {TerminalInputProvider, useTerminalInput} from "../../src/ui/input/terminalInput.js";
import {InputBox} from "../../src/ui/input/InputBox.js";
import {TextInput} from "../../src/ui/input/TextInput.js";
import {ConfirmDialog} from "../../src/ui/dialogs/ConfirmDialog.js";

const start = "\x1b[200~", end = "\x1b[201~";
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(cleanup);

describe("bracketed paste through Ink input", () => {
    test("a delayed 19-line + 3-line paste creates one capsule and submits complete text once", async () => {
        const submitted: string[] = [];
        const a = "first\r\n".repeat(19), b = "tail\n".repeat(3);
        const app = render(<TerminalInputProvider><InputBox disabled={false} onSubmit={v => submitted.push(v)}/></TerminalInputProvider>);
        await tick(); app.stdin.write(start + a); await tick(130);
        expect(app.lastFrame()).not.toContain("Pasted text");
        app.stdin.write(b + end); await tick();
        expect(app.lastFrame()).toContain("[Pasted text #1 +22 lines]");
        expect(app.lastFrame()).not.toContain("#2");
        expect(submitted).toEqual([]);
        app.stdin.write("补充"); await tick();
        app.stdin.write("\r"); await tick();
        expect(submitted).toEqual([(a + b).replaceAll("\r\n", "\n") + "补充"]);
    });
    test("split markers and CRLF preserve text; trailing Enter submits only the new value", async () => {
        const submitted: string[] = [];
        const app = render(<TerminalInputProvider><InputBox disabled={false} onSubmit={v => submitted.push(v)}/></TerminalInputProvider>);
        await tick();
        for (const part of ["\x1b[2", "00~one\r", "\ntwo\r", "three\n", "four\x1b[20", "1~\r"]) app.stdin.write(part);
        await tick();
        expect(submitted).toEqual(["one\ntwo\nthree\nfour"]);
        expect(app.lastFrame()).not.toContain("Pasted text");
    });
    test("a partial marker and an incomplete paste do not leak into input after a delay", async () => {
        const submitted: string[] = [];
        const app = render(<TerminalInputProvider><InputBox disabled={false} onSubmit={v => submitted.push(v)}/></TerminalInputProvider>);
        await tick(); app.stdin.write("\x1b[20"); await tick(130);
        expect(app.lastFrame()).not.toContain("[20");
        app.stdin.write("0~a\nb\nc\nd\r1\x03"); await tick(130);
        expect(app.lastFrame()).not.toContain("Pasted text");
        expect(submitted).toEqual([]);
        app.stdin.write("\x1b[20"); await tick(130); app.stdin.write("1~"); await tick();
        expect(app.lastFrame()).toContain("[Pasted text #1 +4 lines]");
        app.stdin.write("\r"); await tick();
        expect(submitted).toEqual(["a\nb\nc\nd\n1"]);
    });
    test("distinct pastes get separate IDs and capsule deletion remains atomic", async () => {
        const submitted: string[] = [];
        const content = "a\nb\nc\nd";
        const app = render(<TerminalInputProvider><InputBox disabled={false} onSubmit={v => submitted.push(v)}/></TerminalInputProvider>);
        await tick(); app.stdin.write(start + content + end + start + content + end); await tick();
        expect(app.lastFrame()).toContain("[Pasted text #1 +3 lines][Pasted text #2 +3 lines]");
        app.stdin.write("\x7f"); await tick();
        expect(app.lastFrame()).not.toContain("#2");
        app.stdin.write("\r"); await tick();
        expect(submitted).toEqual([content]);
    });
    test("paste controls never run shortcuts; real arrows and Escape still work", async () => {
        const shortcuts: string[] = [], submitted: string[] = [];
        function Tree() {
            useTerminalInput((text, key) => {if (key.escape || key.ctrl) shortcuts.push(text);});
            return <InputBox disabled={false} onSubmit={v => submitted.push(v)}/>;
        }
        const app = render(<TerminalInputProvider><Tree/></TerminalInputProvider>);
        await tick(); app.stdin.write(start + "before\r\n\t\x03\x1b[Aafter" + end); await tick();
        expect(shortcuts).toEqual([]); expect(submitted).toEqual([]);
        app.stdin.write("\x1b[D"); await tick(); app.stdin.write("!"); await tick();
        app.stdin.write("\r"); await tick();
        expect(submitted).toEqual(["before\n    afte!r"]);
        app.stdin.write("\x1b"); await tick(40);
        expect(shortcuts).toHaveLength(1);
    });
    test("an unmounted target never delivers its unfinished paste to the next field", async () => {
        function Field({id}: {id: string}) {
            const [value, setValue] = useState("");
            return <TextInput value={value} onChange={setValue} onSubmit={() => {}} placeholder={id}/>;
        }
        const app = render(<TerminalInputProvider><Field key="a" id="first"/></TerminalInputProvider>);
        await tick(); app.stdin.write(start + "old-target"); await tick();
        app.rerender(<TerminalInputProvider><Field key="b" id="second"/></TerminalInputProvider>);
        await tick(); app.stdin.write(end); await tick();
        expect(app.lastFrame()).not.toContain("old-target");
        expect(app.lastFrame()).toContain("second");
        app.stdin.write(start + "new-target" + end); await tick();
        expect(app.lastFrame()).toContain("new-target");
    });
    test("single-line masked fields receive a delayed paste once without auto-submit", async () => {
        const changes: string[] = [], submitted: string[] = [];
        function Field() {
            const [value, setValue] = useState("");
            return <TextInput value={value} mask="•" onChange={v => {changes.push(v); setValue(v);}} onSubmit={v => submitted.push(v)}/>;
        }
        const app = render(<TerminalInputProvider><Field/></TerminalInputProvider>);
        await tick(); app.stdin.write(start + "secret-"); await tick(130);
        app.stdin.write("key\r\n" + end); await tick();
        expect(changes).toEqual(["secret-key "]);
        expect(submitted).toEqual([]);
        expect(app.frames.join("\n")).not.toContain("secret");
        app.stdin.write("\x7f"); await tick(); app.stdin.write("\r"); await tick();
        expect(submitted).toEqual(["secret-key"]);
    });
    test("pasted consent and control keys cannot approve a permission dialog", async () => {
        const decisions: unknown[] = [];
        const app = render(<TerminalInputProvider><ConfirmDialog req={{id:1, toolName:"bash", input:{command:"pwd"},
            question:"Run command?", resolve: decision => decisions.push(decision)}} onDone={() => {}}/></TerminalInputProvider>);
        await tick(); app.stdin.write(start + "1"); await tick(130); app.stdin.write("\r\x03" + end); await tick();
        expect(decisions).toEqual([]);
        app.stdin.write("3"); await tick();
        expect(decisions).toEqual([{behavior:"deny",message:"User denied"}]);
    });
});
