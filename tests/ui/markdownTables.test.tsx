import {afterEach, expect, test} from "bun:test";
import {Box, Text} from "ink";
import {cleanup, render} from "ink-testing-library";
import stringWidth from "string-width";
import {TerminalMarkdown, layoutTerminalMarkdown} from "../../src/ui/conversation/TerminalMarkdown.js";

afterEach(cleanup);
const result = "真实 Chrome 加载成功，返回 Example Domain，完整正文不能因窗口宽度而丢失。";
const table = `| 步骤 | 结果 |\n| --- | --- |\n| **导航** | ${result} |\n| 检查 | \`heading\` 支持 👨‍👩‍👧‍👦 |`;
const compact = (text: string) => text.replace(/\s/g, "");

test.each([100, 60, 30, 18])("tables preserve complete cells in both render paths at %d columns", width => {
    const direct = render(<Box width={width}><TerminalMarkdown value={table} width={width}/></Box>).lastFrame() ?? "";
    const rows = layoutTerminalMarkdown(table, width);
    const paged = render(<Box width={width} flexDirection="column">{rows.map((row, i) => <Text key={i}>{row}</Text>)}</Box>).lastFrame() ?? "";
    for (const output of [direct, paged]) {
        expect(compact(output)).toContain(compact(result));
        expect(output).not.toContain("…");
        expect(output).not.toContain("**导航**");
        expect(output).not.toContain("`heading`");
        expect(output).toContain("👨‍👩‍👧‍👦");
        expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
        if (width < 38) expect(output).toContain("结果:");
    }
});
