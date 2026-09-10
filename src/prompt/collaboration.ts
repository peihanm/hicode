import type {CollaborationMode} from "../collaboration/index.js";
import type {Message} from "../llm/types.js";

export function withCollaborationMode(messages: Message[], mode: CollaborationMode): Message[] {
    const first = messages[0];
    if (!first || first.role !== "system") return messages;
    const instruction = mode === "plan"
        ? "当前工作方式：Plan。只探索、澄清和交付方案，不实施项目修改。可以运行不修改项目实现的检查、测试及其正常构建产物。用户在对话里要求执行不会切换模式；等用户通过客户端切回 Build。"
        : "当前工作方式：Build。按已授权目标完成调查、实现和验证。无需因任务复杂再审批计划，不能自行切换到 Plan。";
    return [{...first, content: `${first.content}\n\n<collaboration_mode>\n${instruction}\n</collaboration_mode>`}, ...messages.slice(1)];
}
