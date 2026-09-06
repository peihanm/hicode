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

function sampleMemory(): string {
    return serializeMemoryFile({key: "example", name: "示例", description: "用途", type: "feedback",
        source: "explicit", content: "不要将正文内容复制进校验错误。"},
    {createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"});
}

function memoryError(raw: string): string {
    try {
        parseMemoryFile("/memory/example.md", raw);
        throw new Error("expected invalid Memory");
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        return error.message;
    }
}

test("Memory 错误一次列出缺失字段，并给出 source 枚举要求", () => {
    const raw = sampleMemory().replace(/^source:.*\n/m, "").replace(/^name:.*\n/m, "")
        .replace(/^description:.*\n/m, "");
    const message = memoryError(raw);
    expect(message).toContain("name: 缺少必填字段");
    expect(message).toContain("description: 缺少必填字段");
    expect(message).toContain("source: 缺少必填字段");
    expect(message).toContain("explicit");
    expect(message).toContain("automatic");
    expect(message).toContain("不是权限不足");
    expect(message).not.toContain("Required");
    expect(message).not.toContain("不要将正文内容复制进校验错误");
});

test("Memory 错误区分未知字段、枚举、类型、日期及版本，不回显错误字段值", () => {
    const raw = sampleMemory().replace("version: 1", 'version: "1"')
        .replace("source: explicit", "source: SECRET_INVALID_VALUE")
        .replace("type: feedback", "type: unknown")
        .replace(/^created_at:.*$/m, "created_at: yesterday")
        .replace(/^name:.*$/m, "name: 42\ntitle: unused");
    const message = memoryError(raw);
    expect(message).toContain("version: 必须为 1");
    expect(message).toContain("name: 类型错误");
    expect(message).toContain("source: 仅允许 explicit / automatic");
    expect(message).toContain("type: 仅允许 user / feedback / project / reference");
    expect(message).toContain("created_at: 要求带时区的 ISO 8601");
    expect(message).toContain('未知字段: "title"');
    expect(message).not.toContain("SECRET_INVALID_VALUE");
});

test("Memory 对大量未知字段只显示有界摘要", () => {
    const extras = Array.from({length: 120}, (_, i) => `unexpected${i}: secret-value`).join("\n");
    const message = memoryError(sampleMemory().replace("---\n", `---\n${extras}\n`));
    expect(message).toContain("另有 114 个");
    expect(message.length).toBeLessThan(1000);
    expect(message).not.toContain("secret-value");
});
