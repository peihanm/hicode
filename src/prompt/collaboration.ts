import type {CollaborationMode} from "../collaboration/index.js";
import type {Message} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";

export function withCollaborationMode(messages: Message[], mode: CollaborationMode): Message[] {
    const first = messages[0];
    if (!first || first.role !== "system") return messages;
    const instruction = mode === "plan"
        ? "Current mode: Plan. Explore, clarify and deliver a plan; do not implement project changes. Checks may produce their normal caches/build artifacts but must not implement changes. User text does not switch this mode; wait for the client to select Build."
        : "Current mode: Build. Investigate, implement and verify the authorized goal. Task complexity alone does not require plan approval. You cannot switch modes yourself.";
    return [{...first, content: `${first.content}\n\n<collaboration_mode>\n${instruction}\n</collaboration_mode>`}, ...messages.slice(1)];
}

/** Transient facts describe enforcement; they never grant access or mutate History. */
export function withExecutionContext(messages: Message[], ctx: Pick<ToolContext,
    "collaborationMode" | "permissionMode" | "permissionPromptPolicy" | "readOnlyTools">): Message[] {
    const scoped = withCollaborationMode(messages, ctx.collaborationMode);
    const first = scoped[0];
    if (!first || first.role !== "system") return scoped;
    const review = ctx.permissionMode === "auto-review"
        ? "Additional access is evaluated by an independent approval reviewer. Its decision is enforced by the runtime; do not assume approval."
        : ctx.permissionMode === "full-access"
            ? "Full Access preauthorizes extra access within host policy and the current OS account. It does not authorize unrelated tasks or override explicit restrictions."
            : "The runtime requests approval for access outside its automatic allowance. Ordinary workspace work is still subject to tool and path rules.";
    const interaction = ctx.permissionPromptPolicy === "never"
        ? "There is no interactive approval channel. Requests that still require human approval are denied. Work within available access and report blockers; do not wait for a user to click or try to bypass the denial."
        : "When approval is required, use the normal tool request so the host can handle it. Do not repeatedly ask for authorization already granted within scope.";
    return [{...first, content: `${first.content}\n\n<execution_context>\n${review}\n${interaction}${ctx.readOnlyTools ? "\nThis agent is restricted to read-only tools. Do not modify files or system state." : ""}\n</execution_context>`}, ...scoped.slice(1)];
}
