import {Buffer} from "node:buffer";
import {chmod, lstat, mkdir, readdir, readFile, unlink,} from "node:fs/promises";
import {basename} from "node:path";
import {withFileLock, writeFileAtomically,} from "../persistence/index.js";
import {classifyMemoryPath, getMemoryEntryPath, getMemoryIndexPath, getMemoryLockPath,} from "./paths.js";
import {parseMemoryFile, serializeMemoryFile} from "./parser.js";
import {memoryKeySchema, memoryUpsertSchema} from "./schema.js";
import type {MemoryChange, MemoryEntry, MemoryIssue, MemoryScanResult, MemoryUpsertInput,} from "./types.js";

const MAX_MEMORY_FILES = 200;
export const MAX_MEMORY_INDEX_LINES = 200;
export const MAX_MEMORY_INDEX_BYTES = 25_000;

function isCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === code
    );
}

function oneLine(value: string): string {
    return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeMarkdownLabel(value: string): string {
    return oneLine(value).replace(/([\\\[\]])/g, "\\$1");
}

function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
    return (
        a.type.localeCompare(b.type) ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key)
    );
}

export function formatMemoryIndex(entries: readonly MemoryEntry[]): string {
    const lines = ["# Pillar Memory", ""];
    for (const entry of [...entries].sort(compareEntries)) {
        if (lines.length >= MAX_MEMORY_INDEX_LINES) break;
        const line = `- [${escapeMarkdownLabel(entry.name)}](${entry.key}.md) — ${oneLine(entry.description)}`;
        const candidate = `${[...lines, line].join("\n")}\n`;
        if (Buffer.byteLength(candidate, "utf8") > MAX_MEMORY_INDEX_BYTES) break;
        lines.push(line);
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

function validateMemoryIndex(raw: string): void {
    if (Buffer.byteLength(raw, "utf8") > MAX_MEMORY_INDEX_BYTES) {
        throw new Error(`MEMORY.md 超过 ${MAX_MEMORY_INDEX_BYTES} bytes`);
    }
    const lines = raw.trim().split(/\r?\n/);
    if (lines.length > MAX_MEMORY_INDEX_LINES) {
        throw new Error(`MEMORY.md 超过 ${MAX_MEMORY_INDEX_LINES} 行`);
    }
    if (lines[0] !== "# Pillar Memory") {
        throw new Error("MEMORY.md 第一行必须是 # Pillar Memory");
    }
    const keys = new Set<string>();
    for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const match = line.match(/^- \[[^\]\r\n]+\]\(([a-z0-9]+(?:-[a-z0-9]+)*)\.md\) — \S.*$/);
        if (!match) {
            throw new Error("MEMORY.md 只能包含一行式主题指针");
        }
        const key = memoryKeySchema.parse(match[1]);
        if (keys.has(key)) throw new Error(`MEMORY.md 包含重复主题: ${key}`);
        keys.add(key);
    }
}

export function boundMemoryIndex(raw: string): {
    content: string;
    truncated: boolean;
} {
    const trimmed = raw.trim();
    const lines = trimmed.split(/\r?\n/);
    let content = lines.slice(0, MAX_MEMORY_INDEX_LINES).join("\n");
    let truncated = lines.length > MAX_MEMORY_INDEX_LINES;
    const source = Buffer.from(content, "utf8");
    if (source.length > MAX_MEMORY_INDEX_BYTES) {
        let end = MAX_MEMORY_INDEX_BYTES;
        while (end > 0 && (source[end]! & 0xc0) === 0x80) end -= 1;
        content = source.subarray(0, end).toString("utf8");
        const newline = content.lastIndexOf("\n");
        if (newline > 0) content = content.slice(0, newline);
        truncated = true;
    }
    return {content, truncated};
}

export interface MemoryStoreLike {
    readonly directory: string;

    list(): Promise<MemoryScanResult>;

    read(key: string): Promise<MemoryEntry | undefined>;

    upsert(input: MemoryUpsertInput): Promise<MemoryChange>;

    forget(key: string): Promise<MemoryChange | undefined>;

    rebuildIndex(): Promise<MemoryScanResult>;

    readIndex(): Promise<string>;

    validateManagedWrite(path: string, content: string): void;

    writeManagedFile(
        path: string,
        content: string,
        expectedContent: string | null
    ): Promise<MemoryChange | undefined>;

    deleteManagedFile(
        path: string,
        expectedContent: string
    ): Promise<MemoryChange | undefined>;

    reconcileIndex(): Promise<MemoryScanResult>;
}

export class MemoryStore implements MemoryStoreLike {
    constructor(readonly directory: string) {}

    private async ensureDirectory(): Promise<void> {
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        const info = await lstat(this.directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error(`Memory 目录不是可信普通目录: ${this.directory}`);
        }
        await chmod(this.directory, 0o700);
    }

    private async readEntryPath(
        path: string,
        expectedKey: string
    ): Promise<MemoryEntry> {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error("Memory 主题必须是普通文件，不能是符号链接");
        }
        const entry = parseMemoryFile(path, await readFile(path, "utf8"));
        if (entry.key !== expectedKey) {
            throw new Error(
                `frontmatter key ${entry.key} 与文件名 ${expectedKey}.md 不一致`
            );
        }
        return entry;
    }

    private async scanUnlocked(): Promise<MemoryScanResult> {
        let directoryEntries;
        try {
            directoryEntries = await readdir(this.directory, {withFileTypes: true});
        } catch (error) {
            if (isCode(error, "ENOENT")) return {entries: [], issues: []};
            throw error;
        }

        const issues: MemoryIssue[] = [];
        const candidates = directoryEntries
            .filter((item) => item.name.endsWith(".md") && item.name !== "MEMORY.md")
            .sort((a, b) => a.name.localeCompare(b.name));
        if (candidates.length > MAX_MEMORY_FILES) {
            issues.push({
                path: this.directory,
                message: `Memory 文件超过 ${MAX_MEMORY_FILES} 个，只加载前 ${MAX_MEMORY_FILES} 个`,
            });
        }

        const entries: MemoryEntry[] = [];
        for (const candidate of candidates.slice(0, MAX_MEMORY_FILES)) {
            const path = getMemoryEntryPathFromFilename(this.directory, candidate.name);
            const expectedKey = basename(candidate.name, ".md");
            const keyResult = memoryKeySchema.safeParse(expectedKey);
            if (!keyResult.success) {
                issues.push({path, message: "Memory 文件名不是合法 key"});
                continue;
            }
            if (candidate.isSymbolicLink() || !candidate.isFile()) {
                issues.push({path, message: "Memory 主题必须是普通文件"});
                continue;
            }
            try {
                entries.push(await this.readEntryPath(path, keyResult.data));
            } catch (error) {
                issues.push({
                    path,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        entries.sort(compareEntries);
        return {entries, issues};
    }

    async list(): Promise<MemoryScanResult> {
        return this.scanUnlocked();
    }

    async read(key: string): Promise<MemoryEntry | undefined> {
        const parsedKey = memoryKeySchema.parse(key);
        const path = getMemoryEntryPath(this.directory, parsedKey);
        try {
            return await this.readEntryPath(path, parsedKey);
        } catch (error) {
            if (isCode(error, "ENOENT")) return undefined;
            throw error;
        }
    }

    async readIndex(): Promise<string> {
        try {
            return await readFile(getMemoryIndexPath(this.directory), "utf8");
        } catch (error) {
            if (isCode(error, "ENOENT")) return "# Pillar Memory\n";
            throw error;
        }
    }

    validateManagedWrite(path: string, content: string): void {
        const managed = classifyMemoryPath(this.directory, path);
        if (!managed) throw new Error("Memory 只允许顶层 MEMORY.md 和主题 Markdown 文件");
        if (managed.kind === "index") {
            validateMemoryIndex(content);
            return;
        }
        const entry = parseMemoryFile(path, content);
        if (entry.key !== managed.key) {
            throw new Error(`frontmatter key ${entry.key} 与文件名 ${managed.key}.md 不一致`);
        }
    }

    private async currentRaw(path: string): Promise<string | null> {
        try {
            const info = await lstat(path);
            if (info.isSymbolicLink() || !info.isFile()) {
                throw new Error("Memory 文件必须是普通文件，不能是符号链接");
            }
            return await readFile(path, "utf8");
        } catch (error) {
            if (isCode(error, "ENOENT")) return null;
            throw error;
        }
    }

    async writeManagedFile(
        path: string,
        content: string,
        expectedContent: string | null
    ): Promise<MemoryChange | undefined> {
        const managed = classifyMemoryPath(this.directory, path);
        if (!managed) throw new Error("Memory 写入路径不合法");
        this.validateManagedWrite(path, content);
        await this.ensureDirectory();
        return withFileLock(getMemoryLockPath(this.directory), async () => {
            const current = await this.currentRaw(path);
            if (current !== expectedContent) {
                throw new Error(`Memory 文件已被其他进程修改，必须重新读取: ${path}`);
            }
            await writeFileAtomically(path, content, 0o600);
            await chmod(path, 0o600);
            if (managed.kind === "index") return undefined;
            const entry = parseMemoryFile(path, content);
            return {
                action: current === null ? "created" : "updated",
                key: managed.key,
                memoryType: entry.type,
            };
        });
    }

    async deleteManagedFile(
        path: string,
        expectedContent: string
    ): Promise<MemoryChange | undefined> {
        const managed = classifyMemoryPath(this.directory, path);
        if (!managed || managed.kind !== "topic") {
            throw new Error("只能删除 Memory 主题文件，不能删除 MEMORY.md");
        }
        await this.ensureDirectory();
        return withFileLock(getMemoryLockPath(this.directory), async () => {
            const current = await this.currentRaw(path);
            if (current === null) return undefined;
            if (current !== expectedContent) {
                throw new Error(`Memory 文件已被其他进程修改，必须重新读取: ${path}`);
            }
            const entry = parseMemoryFile(path, current);
            await unlink(path);
            return {
                action: "forgotten",
                key: managed.key,
                memoryType: entry.type,
            };
        });
    }

    private async writeIndex(entries: readonly MemoryEntry[]): Promise<void> {
        const path = getMemoryIndexPath(this.directory);
        await writeFileAtomically(path, formatMemoryIndex(entries), 0o600);
        await chmod(path, 0o600);
    }

    async upsert(input: MemoryUpsertInput): Promise<MemoryChange> {
        const parsed = memoryUpsertSchema.parse(input);
        await this.ensureDirectory();
        return withFileLock(getMemoryLockPath(this.directory), async () => {
            const path = getMemoryEntryPath(this.directory, parsed.key);
            let existing: MemoryEntry | undefined;
            try {
                existing = await this.readEntryPath(path, parsed.key);
            } catch (error) {
                if (!isCode(error, "ENOENT")) throw error;
            }
            const timestamp = new Date().toISOString();
            await writeFileAtomically(
                path,
                serializeMemoryFile(parsed, {
                    createdAt: existing?.createdAt ?? timestamp,
                    updatedAt: timestamp,
                }),
                0o600
            );
            await chmod(path, 0o600);
            const scan = await this.scanUnlocked();
            await this.writeIndex(scan.entries);
            return {
                action: existing ? "updated" : "created",
                key: parsed.key,
                memoryType: parsed.type,
            };
        });
    }

    async forget(key: string): Promise<MemoryChange | undefined> {
        const parsedKey = memoryKeySchema.parse(key);
        await this.ensureDirectory();
        return withFileLock(getMemoryLockPath(this.directory), async () => {
            const path = getMemoryEntryPath(this.directory, parsedKey);
            let existing: MemoryEntry;
            try {
                existing = await this.readEntryPath(path, parsedKey);
            } catch (error) {
                if (isCode(error, "ENOENT")) return undefined;
                throw error;
            }
            await unlink(path);
            const scan = await this.scanUnlocked();
            await this.writeIndex(scan.entries);
            return {
                action: "forgotten",
                key: parsedKey,
                memoryType: existing.type,
            };
        });
    }

    async rebuildIndex(): Promise<MemoryScanResult> {
        await this.ensureDirectory();
        return withFileLock(getMemoryLockPath(this.directory), async () => {
            const scan = await this.scanUnlocked();
            await this.writeIndex(scan.entries);
            return scan;
        });
    }

    async reconcileIndex(): Promise<MemoryScanResult> {
        await this.ensureDirectory();
        return withFileLock(getMemoryLockPath(this.directory), async () => {
            const scan = await this.scanUnlocked();
            const expected = formatMemoryIndex(scan.entries);
            const current = await this.currentRaw(
                getMemoryIndexPath(this.directory)
            );
            if (current !== expected) await this.writeIndex(scan.entries);
            return scan;
        });
    }
}

function getMemoryEntryPathFromFilename(
    directory: string,
    filename: string
): string {
    const key = basename(filename, ".md");
    const parsed = memoryKeySchema.safeParse(key);
    return parsed.success
        ? getMemoryEntryPath(directory, parsed.data)
        : `${directory}/${filename}`;
}
