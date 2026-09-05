import {createHash} from "node:crypto";

export const MAX_PLAN_CHARS = 100_000;

/** The permission input is a detached snapshot; its trimmed content is the approval object. */
export function planReview(plan: string): {content: string; version: string} {
    const content = plan.trim();
    return {content, version: createHash("sha256").update(content).digest("hex")};
}
