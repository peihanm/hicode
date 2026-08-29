// "don't ask again" 自动写入
// 用户选 "2. Yes, and don't ask again for this project" 时调用
//
// 流程：
// 1. 生成规则字符串（如 "bash(ls:*)" 或 "write_file"）
// 2. 写入 .pillar/settings.local.json
// 3. 更新内存里的 permissionRules

import {generateShellAllowPattern} from "./shellCommand.js";
import {parsePermissionRule} from "./rules.js";
import type {PermissionRule, PermissionRules} from "./types.js";
import {appendLocalPermissionAllowRule} from "../settings/index.js";

// 生成规则字符串
// bash: 写 "bash(command_prefix:*)" 或复合规则，其他工具：整工具放行
export function generateRuleForTool(
    toolName: string,
    input: unknown
): string | null {
    if (toolName === "bash") {
        const {command} = input as { command: string };
        const pattern = generateShellAllowPattern(command);
        if (!pattern) return null;
        return `bash(${pattern})`;
    }
    if (toolName === "web_fetch") {
        const url = (input as {url?: unknown})?.url;
        if (typeof url !== "string") return null;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return null;
            }
            return `web_fetch(domain:${parsed.hostname.toLowerCase()})`;
        } catch {
            return null;
        }
    }
    // 其他工具：默认整工具放行
    return toolName;
}

// 写入规则到 settings.local.json + 更新内存 rules
export async function addToAllowList(
    ruleStr: string,
    rules: PermissionRules,
    cwd: string = process.cwd()
): Promise<PermissionRules> {
    await appendLocalPermissionAllowRule(cwd, ruleStr);

    const parsed = parsePermissionRule(ruleStr);
    const alreadyInMemory = rules.allow.some(
        (rule) =>
            rule.source === "local" &&
            rule.toolName === parsed.toolName &&
            rule.content === parsed.content
    );
    if (alreadyInMemory) return rules;

    const newRule: PermissionRule = {
        ...parsed,
        source: "local",
    };
    return {
        ...rules,
        allow: [...rules.allow, newRule],
    };
}
