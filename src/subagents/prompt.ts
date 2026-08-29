import type {AgentDefinition} from "./types.js";

export function createAgentSystemPrompt(
    definition: AgentDefinition,
    cwd: string,
    model: string,
    allowedTools: readonly string[] = definition.allowedTools
): string {
    return [
        definition.systemPrompt,
        "",
        "## 运行环境",
        `工作目录：${cwd}`,
        `模型：${model}`,
        `可用工具：${allowedTools.join(", ")}`,
    ].join("\n");
}
