import {describe, expect, test} from "bun:test";
import {
    parseMemoryFile,
    serializeMemoryFile,
} from "../../src/memory/index.js";

describe("Memory schema", () => {
    test("主题文件 round trip 保留四类元数据和正文", () => {
        const raw = serializeMemoryFile(
            {
                key: "feedback-test-boundaries",
                name: "测试边界",
                description: "不要为了测试扩张生产接口",
                type: "feedback",
                source: "explicit",
                content: "保持生产 API 诚实。",
            },
            {
                createdAt: "2026-07-20T00:00:00.000Z",
                updatedAt: "2026-07-20T00:00:00.000Z",
            }
        );
        const parsed = parseMemoryFile("/memory/feedback-test-boundaries.md", raw);
        expect(parsed).toMatchObject({
            version: 1,
            key: "feedback-test-boundaries",
            type: "feedback",
            source: "explicit",
            content: "保持生产 API 诚实。",
        });
    });

    test("拒绝目录穿越 key、未知类型和超大正文", () => {
        expect(() => serializeMemoryFile(
            {
                key: "../escape",
                name: "bad",
                description: "bad",
                type: "project",
                source: "explicit",
                content: "bad",
            },
            {
                createdAt: "2026-07-20T00:00:00.000Z",
                updatedAt: "2026-07-20T00:00:00.000Z",
            }
        )).toThrow();
        expect(() => parseMemoryFile("/memory/bad.md", `---
version: 1
key: bad
name: bad
description: bad
type: other
source: explicit
created_at: 2026-07-20T00:00:00.000Z
updated_at: 2026-07-20T00:00:00.000Z
---

content
`)).toThrow("frontmatter 无效");
        expect(() => serializeMemoryFile(
            {
                key: "large-memory",
                name: "large",
                description: "large",
                type: "project",
                source: "explicit",
                content: "界".repeat(20_000),
            },
            {
                createdAt: "2026-07-20T00:00:00.000Z",
                updatedAt: "2026-07-20T00:00:00.000Z",
            }
        )).toThrow("超过");
    });
});
