export const MEMORY_TYPES = [
    "user",
    "feedback",
    "project",
    "reference",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
type MemorySource = "explicit" | "automatic";
export interface MemoryEntry {
    version: 2;
    key: string;
    name: string;
    description: string;
    type: MemoryType;
    source: MemorySource;
    evidence: readonly import("./publicationSchema.js").MemorySourceRecord["origin"][];
    createdAt: string;
    updatedAt: string;
    content: string;
    path: string;
}
interface MemoryIssue {
    path: string;
    message: string;
}
export interface MemoryScanResult {
    entries: MemoryEntry[];
    issues: MemoryIssue[];
}
export interface MemoryChange {
    action: "created" | "updated";
    key: string;
    memoryType: MemoryType;
}
export interface MemoryContextResult {
    block?: string;
    ignoredForTurn: boolean;
}
export type MemoryFileAccess = import("./publicationAccess.js").PublicationFileAccess;
export interface MemoryRuntimeStatus {
    enabled: boolean;
    autoExtract: boolean;
    pending: number;
    published: number;
    maintaining: boolean;
    directory: string;
    counts: Record<MemoryType, number>;
    issues: MemoryIssue[];
}

/** Read diagnostics contain a path and a controlled reason, never raw file/YAML content. */
export class MemoryReadError extends Error {
    constructor(readonly path: string, readonly detail: string) {
        super(`Memory read failed at ${JSON.stringify(path)}: ${detail}`);
        this.name = "MemoryReadError";
    }
}
