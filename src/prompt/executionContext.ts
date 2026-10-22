import type {Message} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";

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
