// Prompt 构造入口
// 参考 claude-code src/constants/prompts.ts:445 的 getSystemPrompt
//
// 拼接顺序（对齐 claude-code 的章节结构）：
// - 身份声明 + 安全策略
// - # System（框架机制）
// - # Doing tasks（任务执行原则）
// - # Using your tools（工具规范）
// - # Executing actions with care（危险操作）
// - # Tone and style + Output efficiency（输出风格）
// - # Environment（稳定宿主信息）
//
// 全段保持静态，利于模型前缀缓存。
// PILLAR.md/currentDate/skills 走 attachment 注入，每次 runAgent 重新注入。

import type {Message} from "../llm/types.js";
import {detectEnv} from "./env.js";
import {
    getActionsSection,
    getDoingTasksSection,
    getEnvSection,
    getIdentitySection,
    getSystemMechanismSection,
    getToneAndStyleSection,
    getToolGuidanceSection,
} from "./sections.js";

// 构造初始 history：只有一条 system message
// cwd、model 只用于构造稳定宿主信息；这里不执行 I/O。
export function createInitialHistory(cwd: string, model: string): Message[] {
    const env = detectEnv(cwd, model);
    const systemContent = [
        getIdentitySection(),
        "",
        getSystemMechanismSection(),
        "",
        getDoingTasksSection(),
        "",
        getToolGuidanceSection(),
        "",
        getActionsSection(),
        "",
        getToneAndStyleSection(),
        "",
        getEnvSection(env),
    ].join("\n");

    return [{role: "system", content: systemContent}];
}

export function updateInitialHistoryModel(
    history: readonly Message[],
    model: string
): Message[] {
    const [system, ...conversation] = history;
    if (!system || system.role !== "system") return [...history];
    return [{
        role: "system",
        content: system.content.replace(/^模型：.*$/m, `模型：${model}`),
    }, ...conversation];
}
