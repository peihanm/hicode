export const MEMORY_TYPES = [
    "user",
    "feedback",
    "project",
    "reference",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemorySource = "explicit" | "automatic";

export interface MemoryEntry {
    version: 2;
    key: string;
    name: string;
    description: string;
    type: MemoryType;
    source: MemorySource;
    createdAt: string;
    updatedAt: string;
    content: string;
    path: string;
}

export interface MemoryIssue {
    path: string;
    message: string;
}

export interface MemoryScanResult {
    entries: MemoryEntry[];
    issues: MemoryIssue[];
}

export interface MemoryChange {
    action: "created" | "updated" | "forgotten";
    key: string;
    memoryType: MemoryType;
}

export interface MemoryContextResult {
    block?: string;
    ignoredForTurn: boolean;
}

export type MemoryManagedPath = import("./publicationAccess.js").PublicationPath;
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
