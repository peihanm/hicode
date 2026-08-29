export const MEMORY_TYPES = [
    "user",
    "feedback",
    "project",
    "reference",
] as const;

export const MAX_MEMORY_CONTENT_BYTES = 32 * 1024;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemorySource = "explicit" | "automatic";

export interface MemoryEntry {
    version: 1;
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

export interface MemoryUpsertInput {
    key: string;
    name: string;
    description: string;
    type: MemoryType;
    content: string;
    source: MemorySource;
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

export type MemoryManagedPath =
    | {kind: "index"; path: string}
    | {kind: "topic"; path: string; key: string};

/** Root-only capability used by standard file tools for managed Memory paths. */
export interface MemoryFileAccess {
    readonly directory: string;

    classify(path: string): MemoryManagedPath | undefined;

    validateWrite(path: string, content: string): void;

    write(
        path: string,
        content: string,
        expectedContent: string | null
    ): Promise<MemoryChange | undefined>;

    delete(
        path: string,
        expectedContent: string
    ): Promise<MemoryChange | undefined>;
}

export interface MemoryRuntimeStatus {
    enabled: boolean;
    autoExtract: boolean;
    directory: string;
    counts: Record<MemoryType, number>;
    issues: MemoryIssue[];
}
