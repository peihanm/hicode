// Persist rules for "don't ask again".
// Called when the user chooses "Yes, and don't ask again for this project".
//
// Flow:
// 1. Generate a rule string such as bash(ls:*) or write_file.
// 2. Write .hicode/settings.local.json.
// 3. Update in-memory permissionRules.

import {generateShellAllowPattern} from "./shellCommand.js";
import {parsePermissionRule} from "./rules.js";
import type {PermissionRule, PermissionRules} from "./types.js";
import {appendLocalPermissionAllowRule} from "../settings/index.js";

// Generate the rule string.
// Bash uses bash(command_prefix:*) or a compound rule; other tools receive whole-tool rules.
export function generateRuleForTool(
    toolName: string,
    input: unknown
): string | null {
    if (
        toolName === "write_file" ||
        toolName === "edit_file"
    ) {
        return null;
    }
    if (toolName === "bash") {
        if (!input || typeof input !== "object" || !("command" in input)) {
            return null;
        }
        const command = input.command;
        if (typeof command !== "string") return null;
        const pattern = generateShellAllowPattern(command);
        if (!pattern) return null;
        return `bash(${pattern})`;
    }
    if (toolName === "web_fetch") {
        const url = input && typeof input === "object" && "url" in input
            ? input.url
            : undefined;
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
    // Default to whole-tool rules for other tools.
    return toolName;
}

// Persist settings.local.json and update in-memory rules.
export async function addToAllowList(
    ruleStr: string,
    rules: PermissionRules,
    cwd: string
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
