export type CollaborationMode = "build" | "plan";

const COLLABORATION_MODES = new Set<CollaborationMode>(["build", "plan"]);

export function isCollaborationMode(value: unknown): value is CollaborationMode {
    return typeof value === "string" &&
        COLLABORATION_MODES.has(value as CollaborationMode);
}

export function parseCollaborationMode(
    value: string
): CollaborationMode | undefined {
    const candidate = value.trim();
    return isCollaborationMode(candidate) ? candidate : undefined;
}

export function getNextCollaborationMode(
    current: CollaborationMode
): CollaborationMode {
    return current === "build" ? "plan" : "build";
}
