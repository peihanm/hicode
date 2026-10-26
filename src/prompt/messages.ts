import type {Message} from "../llm/types.js";
import type {LoadedSkill} from "../skills/types.js";
import type {ToolContext} from "../tools/types.js";
import {EMPTY_PROJECT_INSTRUCTIONS, formatProjectInstructions} from "./instructions.js";
import type {ProjectInstructions} from "./instructions.js";

// UserContext injection.
//
// A synchronous function returns userContext text fragments without a message wrapper.
// buildInvokeMessages() joins these fragments into one transient user message
// after system and before real user input.
//
// Injection policy:
// - HICODE.md: Root startup snapshot, same content each request.
// - currentDate: injected each request.
// - Skill list: same bytes each request for a stable cache prefix.
//
// Do not deduplicate Skills across requests:
// - Skills are loaded at startup and stay stable within the session.
// - Removing the Skill block after the first request would break the cached prefix.
// - Repeating it preserves the userContext message structure after system.

// Format the Skill list.
function formatSkillListing(skills: LoadedSkill[]): string {
    if (skills.length === 0) return "";
    const lines = skills.map(skill => `- ${skill.name}: ${skill.description}`);
    return `Available Skills (invoke skill with the skill parameter):\n${lines.join("\n")}`;
}

// Build userContext text fragments.
// Each block uses system-reminder tags; buildInvokeMessages() wraps them in a transient user message.
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

// Local date in YYYY-MM-DD format for the currentDate attachment.
function getLocalISODate(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// History stores real user/assistant/tool conversation, not userContext.
// Before each callLLM, insert userContext as a transient user message after system:
// [system, userContext, firstUser, assistant/tool/later user...]
// This keeps real user input separate from system-reminder messages in prompt logs,
// while userContext remains in the stable prefix for provider caching.
export function buildInvokeMessages(
    history: Message[],
    userContextBlocks: string[]
): Message[] {
    // Keep rejected input for recovery/display, without replaying its text or pixels as a task.
    const projected = history.map((message): Message => message.role === "user" && message.origin === "hook_rejected"
        ? {role: "user", origin: "runtime", content: "An earlier request was rejected by UserPromptSubmit. Its contents were not accepted as instructions and are omitted from this model request."}
        : message);
    const system = projected[0];
    if (!system || system.role !== "system") {
        return projected;
    }

    if (history.length <= 1 || userContextBlocks.length === 0) {
        return projected;
    }

    const userContextMessage: Message = {
        role: "user", origin: "runtime" as const,
        content: userContextBlocks.join("\n\n"),
    };

    return [system, userContextMessage, ...projected.slice(1)];
}

/** Transient facts describe enforcement; they never grant access or mutate History. */
export function withExecutionContext(messages: Message[], ctx: Pick<ToolContext,
    "permissionMode" | "permissionPromptPolicy" | "readOnlyTools">): Message[] {
    const first = messages[0];
    if (!first || first.role !== "system") return messages;
    const review = ctx.permissionMode === "auto-review"
        ? "Additional access is evaluated by an independent approval reviewer. Its decision is enforced by the runtime; do not assume approval."
        : ctx.permissionMode === "full-access"
            ? "Full Access preauthorizes extra access within host policy and the current OS account. It does not authorize unrelated tasks or override explicit restrictions."
            : "The runtime requests approval for access outside its automatic allowance. Ordinary workspace work is still subject to tool and path rules.";
    const interaction = ctx.permissionPromptPolicy === "never"
        ? "There is no interactive approval channel. Requests that still require human approval are denied. Work within available access and report blockers; do not wait for a user to click or try to bypass the denial."
        : "When approval is required, use the normal tool request so the host can handle it. Do not repeatedly ask for authorization already granted within scope.";
    return [{...first, content: `${first.content}\n\n<execution_context>\n${review}\n${interaction}${ctx.readOnlyTools ? "\nThis agent is restricted to read-only tools. Do not modify files or system state." : ""}\n</execution_context>`}, ...messages.slice(1)];
}
