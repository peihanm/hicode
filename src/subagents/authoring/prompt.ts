import type {ProjectInstructions} from "../../prompt/instructions.js";

const MAX_INSTRUCTION_CHARS = 20_000;

export function createAgentAuthoringPrompt({
    availableToolNames,
    existingAgentNames,
    instructions,
}: {
    availableToolNames: readonly string[];
    existingAgentNames: readonly string[];
    instructions: ProjectInstructions;
}): string {
    const projectRules = instructions.files
        .map((file) =>
            `### ${file.scope === "host" ? `host:${file.id}` : file.path}\n${file.content}`
        )
        .join("\n\n")
        .slice(0, MAX_INSTRUCTION_CHARS);
    return [
        "你负责为 Pillar 生成一个自定义子 Agent 候选定义。",
        "只调用 submit_agent_definition 一次，不输出普通正文。",
        "候选必须职责单一、触发条件清楚、工具最小化；不得建议 Agent、Task、Memory、Plan、Todo、Skill 或 Git Commit 控制面工具。",
        "System Prompt 必须明确能力边界、工作方法和最终输出要求。不要声称拥有列表之外的工具。",
        `可选工具：${availableToolNames.join(", ")}`,
        `已有 Agent 名称：${existingAgentNames.join(", ") || "无"}`,
        projectRules ? `项目规则快照：\n${projectRules}` : "项目没有 PILLAR.md 规则。",
    ].join("\n\n");
}
