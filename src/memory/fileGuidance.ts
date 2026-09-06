import {serializeMemoryFile} from "./parser.js";
import {memoryFrontmatterSchema} from "./schema.js";
import type {MemorySource} from "./types.js";

export function formatMemoryFileGuidance(source: MemorySource): string {
    const example = serializeMemoryFile({
        key: "example-topic",
        name: "示例主题",
        description: "本主题的用途",
        type: "feedback",
        source,
        content: "替换为需要保存的长期信息及其适用范围。",
    }, {createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"});
    return [
        "## Memory 主题文件格式",
        `所有字段均必填：${memoryFrontmatterSchema.keyof().options.join("、")}；不接受 title、scope 等额外字段。`,
        `type 仅允许 ${memoryFrontmatterSchema.shape.type.options.join(" / ")}；source 仅允许 ${memoryFrontmatterSchema.shape.source.options.join(" / ")}。本入口新建主题使用 source: ${source}。`,
        "version 必须为数字 1；key 使用小写字母/数字和单个连字符分隔，必须与文件名 <key>.md 一致。name 和 description 是非空单行文本。",
        "created_at 和 updated_at 使用带时区的 ISO 8601 时间。更新前读取主题，保留 version、key、created_at，更新 updated_at。",
        "以下是新建 example-topic.md 的完整格式示例；替换示例 key、名称、说明、类型、正文与时间，时间使用实际创建/更新时间，不照抄示例日期。空索引是正常状态，不需要先找旧主题当样例。",
        "```yaml",
        example.trimEnd(),
        "```",
        "主题写入成功后再更新 MEMORY.md 索引。格式错误按返回的字段问题修正；无需提权，不要扫描其他项目、Prompt Log 或安装目录来猜格式。",
    ].join("\n");
}
