import {expect, test} from "bun:test";
import {render} from "ink";
import {PassThrough, Writable} from "node:stream";
import {createTerminalCursorOutput} from "../../src/ui/input/terminalCursor.js";
import {TerminalCursorAnchorProvider} from "../../src/ui/input/terminalCursorContext.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {abortableDelay, normalizeTurnAbortReason} from "../../src/runtime/abort.js";
import type {AgentRunner} from "../../src/agent/index.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 80));

test("真实 Ink 输出在取消后再次输入仍定位输入框", async () => withTempProject(async cwd => {
    const chunks: string[] = [];
    const target = Object.assign(new Writable({write(chunk, _encoding, done) {chunks.push(String(chunk)); done();}}),
        {columns: 200, rows: 40, isTTY: true});
    const stdout = createTerminalCursorOutput(target as NodeJS.WriteStream);
    const expectAnchor = (column: number) => {
        const index = chunks.findLastIndex(chunk => chunk.includes("❯"));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(chunks[index]).toEndWith(`\u001b7\u001b[4A\u001b[${column}G`);
        expect(chunks.slice(index + 1).join("")).not.toContain("\u001b8");
        expect(chunks.join("")).not.toContain("hicode-cursor://");
        expect(chunks.join("")).not.toContain("\u200c");
    };
    const input = Object.assign(new PassThrough(), {isTTY: true, setRawMode() {return this;}, ref() {return this;}, unref() {return this;}});
    const stdin = new Proxy(process.stdin, {
        get(target, property) {
            const source = property in input ? input : target;
            const value = Reflect.get(source, property, source);
            return typeof value === "function" ? value.bind(source) : value;
        },
    });
    const resources = createTestRuntimeResources(cwd);
    let ready!: () => void;
    const started = new Promise<void>(resolve => {ready = resolve;});
    const runner: AgentRunner = async (_input, _history, onEvent, ctx) => {
        ready();
        try {await abortableDelay(10000, ctx.signal);} catch {}
        const reason = normalizeTurnAbortReason(ctx.signal.reason);
        await onEvent({type: "turn_interrupted", reason});
        return {reply: "", reason: "interrupted", iterations: 1, abortReason: reason};
    };
    const app = render(<TerminalCursorAnchorProvider enabled><AppForTest resources={resources} runAgentImpl={runner}/></TerminalCursorAnchorProvider>,
        {stdout, stderr: stdout, stdin, patchConsole: false, exitOnCtrlC: false});
    try {
        await tick();
        expectAnchor(3);
        input.write("?"); await tick(); input.write("\r");
        await started; await tick(); input.write("\x1b"); await tick(); await tick();
        expectAnchor(3);
        input.write("?"); await tick();
        expectAnchor(4);
        input.write("\u001b[D"); await tick();
        expectAnchor(3);
        expect(chunks.findLast(chunk => chunk.includes("❯"))).toContain("❯ ?");
        input.write("好"); await tick();
        expectAnchor(5);
        expect(chunks.findLast(chunk => chunk.includes("❯"))).toContain("❯ 好?");
    } finally {app.unmount(); app.cleanup(); stdout.disposeCursorOutput(); await resources.close(); input.destroy();}
}));
