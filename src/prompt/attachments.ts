// UserContext injection.
// Based on Claude Code prependUserContext in src/utils/api.ts
// and normalizeMessagesForAPI, which merges consecutive user messages.
//
// A synchronous function returns userContext text fragments without a message wrapper.
// invokeMessages.ts joins these fragments into one transient user message
// after system and before real user input.
//
// Injection policy:
// - PILLAR.md: Root startup snapshot, same content each request.
// - currentDate: injected each request.
// - Skill list: same bytes each request for a stable cache prefix.
//
// Do not deduplicate Skills across requests:
// - Skills are loaded at startup and stay stable within the session.
// - Removing the Skill block after the first request would break the cached prefix.
// - Repeating it preserves the userContext message structure after system.

import type {LoadedSkill} from "../skills/types.js";
import {getLocalISODate} from "./date.js";
import {EMPTY_PROJECT_INSTRUCTIONS, formatProjectInstructions, type ProjectInstructions,} from "./instructions.js";

// Format the Skill list.
function formatSkillListing(skills: LoadedSkill[]): string {
    if (skills.length === 0) return "";
    const lines = skills.map((s) => {
        const desc = s.whenToUse ? `${s.description} — ${s.whenToUse}` : s.description;
        return `- ${s.name}: ${desc}`;
    });
    return `Available Skills (invoke skill with the skill parameter):\n${lines.join("\n")}`;
}

// Build userContext text fragments.
// Each block uses system-reminder tags; invokeMessages.ts wraps them in a transient user message.
//
// Skills/instructions are Root startup snapshots, reinjected for prefix stability.
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

    // Inject currentDate on every request.
    blocks.push(
        `<system-reminder>\n` +
        `As you answer the user's questions, you can use the following context:\n` +
        `# currentDate\nToday's date is ${getLocalISODate()}.\n\n` +
        `      IMPORTANT: this context may or may not be relevant to your tasks. ` +
        `You should not respond to this context unless it is highly relevant to your task.\n` +
        `</system-reminder>`
    );

    // Inject the stable Skill list each request to keep messages[1] consistent.
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
