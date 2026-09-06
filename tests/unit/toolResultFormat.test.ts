import {expect, test} from "bun:test";
import {createPreview} from "../../src/toolResults/format.js";

test("首尾预览保留失败汇总并标明中间省略，短结果原样返回", () => {
    const content = `START\n${"pass\n".repeat(2000)}FAIL: 1 test`;
    const preview = createPreview(content, 2000);
    expect(preview.startsWith("START\n")).toBe(true);
    expect(preview.endsWith("FAIL: 1 test")).toBe(true);
    expect(preview).toContain("[middle omitted]");
    expect(preview.length).toBeLessThanOrEqual(2000);
    expect(createPreview("完整😀\n", 100)).toBe("完整😀\n");
});

test("首尾截断在极小预算和 Unicode 边界上也不超限或切坏字符", () => {
    for (const content of ["😀".repeat(200), "你😀a\n".repeat(200)]) {
        for (let budget = 0; budget < 120; budget++) {
            const preview = createPreview(content, budget);
            expect(preview.length).toBeLessThanOrEqual(budget);
            expect(Buffer.from(preview).toString("utf8")).toBe(preview);
            if (budget > 0) expect(preview).toMatch(/…|\[middle omitted\]/);
        }
    }
});
