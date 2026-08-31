// UserContext 注入
// 参考 claude-code src/utils/api.ts:449-474 的 prependUserContext
// 和 normalizeMessagesForAPI（services/api/claude.ts:1290）合并连续 user msg
//
// 简化版：同步函数，返回 userContext 的文本片段（不包 user message 外壳）。
// invokeMessages.ts 会把这些片段拼成一条独立的临时 user message，
// 插在 system 后、真实用户输入前。
//
// 注入策略：
// - PILLAR.md：Root Runtime 启动快照，每次注入同样内容
// - currentDate：每次注入
// - skills 列表：每次注入（内容固定，字节一致，保证前缀稳定以命中 cache）
//
// 不做 skills 去重：
// - skills 内容在启动时加载，会话内不变，每次注入同样字符串
// - 如果首次注入后续不注入，首次请求有 skills block，后续没有，前缀断裂 cache miss
// - 每次注入能让 system 后的 userContext message 结构稳定，cache 命中

import type {LoadedSkill} from "../skills/types.js";
import {getLocalISODate} from "./date.js";
import {EMPTY_PROJECT_INSTRUCTIONS, formatProjectInstructions, type ProjectInstructions,} from "./instructions.js";

// 格式化 skills 列表
function formatSkillListing(skills: LoadedSkill[]): string {
    if (skills.length === 0) return "";
    const lines = skills.map((s) => {
        const desc = s.whenToUse ? `${s.description} — ${s.whenToUse}` : s.description;
        return `- ${s.name}: ${desc}`;
    });
    return `可用 skill（用 skill 工具调用，传 skill 参数）：\n${lines.join("\n")}`;
}

// 构造 userContext 的文本片段。
// 每个 block 包 <system-reminder>，由 invokeMessages.ts 放入独立的临时 user message。
//
// skills/instructions: Root Runtime 启动快照（每次注入，保证前缀稳定）
export function getUserContextBlocks(
    skills: LoadedSkill[],
    instructions: ProjectInstructions = EMPTY_PROJECT_INSTRUCTIONS
): string[] {
    const blocks: string[] = [];

    const instructionContent = formatProjectInstructions(instructions);
    if (instructionContent) {
        blocks.push(
            `<system-reminder>\n` +
            `${instructionContent}\n` +
            `</system-reminder>`
        );
    }

    // currentDate：每次注入
    blocks.push(
        `<system-reminder>\n` +
        `As you answer the user's questions, you can use the following context:\n` +
        `# currentDate\nToday's date is ${getLocalISODate()}.\n\n` +
        `      IMPORTANT: this context may or may not be relevant to your tasks. ` +
        `You should not respond to this context unless it is highly relevant to your task.\n` +
        `</system-reminder>`
    );

    // Skills 列表：每次注入（内容固定，保证 messages[1] blocks 结构稳定）
    if (skills.length > 0) {
        blocks.push(
            `<system-reminder>\n` +
            `The following skills are available for use with the skill tool:\n\n` +
            formatSkillListing(skills) +
            `\n</system-reminder>`
        );
    }

    return blocks;
}
