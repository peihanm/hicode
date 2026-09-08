import { describe, expect, test } from "bun:test";
import {
  parseBinaryArtifactMetadata,
  parseTextArtifactMetadata,
} from "../../src/toolResults/artifactMetadata.js";

describe("tool result metadata", () => {
  test("解析兼容的 text metadata 并拒绝 identity/size 不一致", () => {
    const valid = {
      resultId: "tr_a",
      toolCallId: "a",
      toolName: "test",
      byteLength: 3,
      originalByteLength: 3,
      complete: true,
      encoding: "utf-8" as const,
    };
    expect(parseTextArtifactMetadata(JSON.stringify(valid), "tr_a")).toEqual(valid);
    expect(parseTextArtifactMetadata(JSON.stringify(valid), "tr_b")).toBeNull();
    expect(
      parseTextArtifactMetadata(
        JSON.stringify({ ...valid, byteLength: 4 }),
        "tr_a"
      )
    ).toBeNull();
  });

  test("解析 binary metadata，path 仅作为兼容字段验证类型", () => {
    const valid = {
      artifactId: "binary-a",
      origin: {kind: "tool" as const, toolCallId: "a", toolName: "mcp"},
      path: "/legacy/path.bin",
      byteLength: 2,
      originalByteLength: 4,
      complete: false,
      encoding: "binary" as const,
      mimeType: "image/png",
    };
    expect(parseBinaryArtifactMetadata(JSON.stringify(valid), "binary-a")).toEqual(valid);
    expect(
      parseBinaryArtifactMetadata(
        JSON.stringify({ ...valid, path: 123 }),
        "binary-a"
      )
    ).toBeNull();
  });
});
