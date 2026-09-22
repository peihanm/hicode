import {afterEach, expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {cleanup, render} from "ink-testing-library";
import {MessageList} from "../../src/ui/conversation/MessageList.js";
import {documentRead} from "../../src/ui/conversation/documentRead.js";
import {threadsFromHistory} from "../../src/ui/conversation/threadReducer.js";
import type {ToolCallThread} from "../../src/ui/conversation/projection.js";
import {createPreview} from "../../src/toolResults/format.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

afterEach(cleanup);

function read(path: string, lines: string[], start = 1, total = lines.length): ToolCallThread {
    const end = start + lines.length - 1;
    return {id: "read", role: "tool_call", toolCallId: "read", name: "read_file", args: JSON.stringify({path}),
        status: "done", outcome: "ok",
        result: `File: ${path}\nLine range: ${start}-${end} / ${total}\nNote: left-hand line numbers are not file content; exclude them from edit_file.edits[].old_string.\n\n` +
            lines.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n")};
}

test("Markdown reads fold to basename/count, render documents on expansion and preserve model read evidence", async () => {
    await withTempProject(async cwd => {
        const path = join(cwd, "subagents.md");
        await writeFile(path, "# Subagent guide\n\nUse **Worker** for bounded implementation.\n\n- Keep ownership clear.");
        const result = await executeToolResult("read_file", JSON.stringify({path}), createTestContext(cwd), "read");
        const history = [{role: "assistant" as const, content: null, tool_calls: [{id: "read", type: "function" as const,
            function: {name: "read_file", arguments: JSON.stringify({path})}}]},
        {role: "tool" as const, tool_call_id: "read", content: result.modelContent}];
        const original = JSON.stringify(history);
        const threads = threadsFromHistory(history, [{version: 1, type: "tool_call", turnId: "turn", toolCallId: "read", timestamp: "2026-09-22T00:00:00.000Z", outcome: "ok"}]);
        const view = render(<MessageList threads={threads} terminalWidth={70}/>);
        expect(view.lastFrame()).toContain("Read subagents.md · 5 lines");
        expect(view.lastFrame()).not.toContain(cwd);
        for (const width of [70, 38]) {
            view.rerender(<MessageList threads={threads} transcript terminalWidth={width}/>);
            const expanded = view.lastFrame() ?? "";
            expect(expanded).toContain("Subagent guide");
            expect(expanded).not.toContain("# Subagent guide");
            expect(expanded).not.toContain("**Worker**");
            expect(expanded).not.toContain("Line range:");
            expect(expanded).not.toContain("left-hand line numbers");
            expect(expanded).not.toMatch(/\b1\s+# Subagent/);
        }
        view.rerender(<MessageList threads={threads} terminalWidth={70}/>);
        expect(view.lastFrame()).not.toContain("Subagent guide");
        expect(JSON.stringify(history)).toBe(original);
        expect(result.modelContent).toContain("     1\t# Subagent guide");
    });
});

test("document projection preserves indentation, embedded numbers, excerpts and truncation/warning markers", () => {
    const lines = ["```ts", "    const value = 42;", "    12\tkeep this text", "```", "1. First step"];
    const thread = read("/project/README.md", lines, 21, 90);
    thread.result += "\n\n... (remaining lines omitted: 65 )\n\nHook warning:\n diagnostic\n    21\tpreserve diagnostic number";
    const doc = documentRead(thread);
    expect(doc?.summary).toBe("Read README.md · lines 21–25 of 90");
    expect(doc?.body).toContain(lines.join("\n"));
    expect(doc?.body).toContain("remaining lines omitted: 65");
    expect(doc?.body).toContain("Hook warning:\n diagnostic");
    expect(doc?.body).toContain("    21\tpreserve diagnostic number");
    const long = read("/project/long.md", Array.from({length: 180}, (_, i) => `Paragraph ${i} ${"word ".repeat(20)}`));
    long.result = createPreview(long.result!, 2000);
    const view = render(<MessageList threads={[long]} transcript terminalWidth={70}/>);
    expect(view.lastFrame()).toContain("middle omitted");
    expect(view.lastFrame()).not.toContain("left-hand line numbers");
});

test("source files, errors and non-file result envelopes keep their original display", () => {
    const source = read("/project/main.ts", ["const n = 1;"]);
    expect(documentRead(source)).toBeUndefined();
    expect(render(<MessageList threads={[source]} transcript/>).lastFrame()).toContain("Line range: 1-1 / 1");
    for (const outcome of ["failed", "denied", "interrupted"] as const) {
        const failed = {...read("/project/README.md", ["# Header"]), outcome};
        expect(documentRead(failed)).toBeUndefined();
        expect(render(<MessageList threads={[failed]} transcript/>).lastFrame()).toContain("Line range:");
    }
    const saved = {...read("/project/output.md", ["# Header"]), result: "Saved output: /project/output.md\nHistorical log"};
    expect(documentRead(saved)).toBeUndefined();
});
