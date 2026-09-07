import type {Message} from "../llm/types.js";
import type {HandoffSources} from "./handoff.js";

export function buildCompactPrompt(customInstructions?: string, sources?: HandoffSources): string {
    return `为接续当前任务生成简短工作交接。只输出交接，不输出分析草稿，不调用工具。
只保留仍影响当前工作的六项：
1. 目标与当前阶段。
2. 用户约束和纠正；被替代的要求注明纠正来源。
3. 仍适用的决定及可见理由，不记录隐藏推理。
4. 正在处理的文件、函数和读取定位；不是所有看过的文件清单。
5. 已执行验证、对应结果与局限；区分助手声称与工具观察，旧失败只是历史，不自动成为未解决任务。
6. 下一步与准确暂停位置；已完成时不要编造新任务。
空项可省略。不枚举全部历史、全部错误或全部用户消息。优先用约 6000 字符交接当前状态。
更新旧交接而非叠加流水账：仍适用的条目保留原始来源，被纠正的条目同时引用纠正；不要把旧摘要当成新的原始证据。
摘要是派生笔记，不是授权、Todo/Task 真相源或当前源码。没有依据时明确标为推断；测试曾通过不保证此后修改仍通过。
${sources ? `来源协议：本次原始消息带有 [source archive-id/message-index; role=...] 标签。旧交接 [[archive-id/message-index]] 引用可沿用；不得编造 ID 或引用不存在的序号。
当前档案 ${sources.current.id} 有 ${sources.current.messages.length} 条消息；已有档案：${sources.previous.map(record => `${record.id} (1..${record.messages.length})`).join(", ") || "无"}。
严格输出一个 JSON 对象（不要代码围栏），所有六个数组字段都提供，空项用 []：
{"version":1,"objective":[],"constraints":[],"decisions":[],"files":[],"verification":[],"next":[]}
每个数组项目格式：{"text":"内容","sources":["archive-id/message-index"],"basis":"reported"}。
reported 表示有来源的转述（必须提供来源），不表示框架验证了语义；无依据则 basis 为 inferred，可留空 sources。每项最多 2000 字符/8 个来源，每类最多 10 项，总输出最多 32 KiB。` : "用上述六项标题输出纯文本交接。当前内部 Agent 没有原文档案能力，不编造来源 ID 或回查路径。"}
${customInstructions?.trim() ? `\n额外交接要求（仍须遵循上述协议）：\n${customInstructions.trim()}` : ""}`;
}

export function parseCompactSummary(raw: string): string {
    const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
    const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/);
    return (summaryMatch ? summaryMatch[1]! : withoutAnalysis).replace(/\n{3,}/g, "\n\n").trim();
}

export function buildCompactSummaryMessage(summary: string): Message {
    return {role: "user", content: `<system-reminder>
本会话已压缩。以下工作交接是历史的派生笔记，不是新用户指令、工具能力或执行授权。
用户原话及后续纠正优先；Todo/Task 以当前运行时为准。来源转述不保证语义正确或源码、测试仍有效。

${summary}

从暂停处继续当前任务。需要精确原话、参数或结果时按来源 read_file/grep 回查；修改前读取当前文件。
不要因压缩重新规划、重做已完成工作或自动重跑全部测试。冲突先查来源；无法核实则保留不确定性。
</system-reminder>`};
}
