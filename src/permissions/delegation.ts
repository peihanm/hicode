import type {ToolContext} from "../tools/types.js";
import type {ApprovalResolution} from "./approval.js";
import type {DirectoryAccessRequest} from "./directoryAccess.js";

export interface PermissionActor {
    agentId: string;
    name: string;
}

/** A validated decision commits to the directory owner, never to a child's local copy. */
export async function commitDirectoryApproval(ctx: ToolContext, request: DirectoryAccessRequest, resolution: ApprovalResolution): Promise<void> {
    const decision = resolution.decision;
    if (decision.behavior !== "allow" || !decision.directoryScope || decision.directoryScope === "once") return;
    if (resolution.source !== "user") throw new Error("Only an explicit user decision can expand directory access");
    await ctx.directoryAccess.grantDirectory(request.suggestedDirectory, decision.directoryScope);
}
