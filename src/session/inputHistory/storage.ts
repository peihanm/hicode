import {constants} from "node:fs";
import {chmod, type FileHandle, mkdir, open, realpath,} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {withFileLock} from "../../persistence/fileLock.js";

const HISTORY_VERSION = 2;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_READ_BYTES = 2 * 1024 * 1024;
const MAX_PERSISTED_INPUT_BYTES = 1024 * 1024;

interface StoredInputHistoryEntry {
    version: 2;
    sessionId: string;
    input: string;
    project: string;
    timestamp: string;
}

export interface InputHistoryStore {
    load(cwd: string, sessionId: string): Promise<string[]>;

    append(cwd: string, sessionId: string, input: string): Promise<void>;
}

export interface CreateInputHistoryStoreOptions {
    historyPath?: string;
    limit?: number;
}

function getInputHistoryPath(): string {
    return join(homedir(), ".pillar", "history.jsonl");
}

async function canonicalProject(cwd: string): Promise<string> {
    try {
        return await realpath(cwd);
    } catch {
        return resolve(cwd);
    }
}

function parseEntry(line: string): StoredInputHistoryEntry | undefined {
    try {
        const value = JSON.parse(line) as Partial<StoredInputHistoryEntry>;
        if (
            value.version !== HISTORY_VERSION ||
            typeof value.sessionId !== "string" ||
            value.sessionId.length === 0 ||
            typeof value.input !== "string" ||
            typeof value.project !== "string" ||
            typeof value.timestamp !== "string"
        ) {
            return undefined;
        }
        return value as StoredInputHistoryEntry;
    } catch {
        return undefined;
    }
}

async function readRecentLines(path: string): Promise<string[]> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(path, constants.O_RDONLY);
        const {size} = await handle.stat();
        const start = Math.max(0, size - MAX_HISTORY_READ_BYTES);
        const buffer = Buffer.alloc(size - start);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
        let content = buffer.subarray(0, bytesRead).toString("utf8");
        if (start > 0) {
            const firstNewline = content.indexOf("\n");
            content = firstNewline === -1 ? "" : content.slice(firstNewline + 1);
        }
        return content.split("\n").filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    } finally {
        await handle?.close().catch(() => {
        });
    }
}

export function createInputHistoryStore(
    options: CreateInputHistoryStoreOptions = {}
): InputHistoryStore {
    const historyPath = options.historyPath ?? getInputHistoryPath();
    const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT));
    let appendQueue = Promise.resolve();

    const appendEntry = async (
        cwd: string,
        sessionId: string,
        input: string
    ): Promise<void> => {
        if (
            !sessionId ||
            !input ||
            Buffer.byteLength(input, "utf8") > MAX_PERSISTED_INPUT_BYTES
        ) {
            return;
        }
        const project = await canonicalProject(cwd);
        const entry: StoredInputHistoryEntry = {
            version: HISTORY_VERSION,
            sessionId,
            input,
            project,
            timestamp: new Date().toISOString(),
        };
        await withFileLock(`${historyPath}.lock`, async () => {
            await mkdir(dirname(historyPath), {recursive: true});
            let handle: FileHandle | undefined;
            try {
                handle = await open(historyPath, "a", 0o600);
                await chmod(historyPath, 0o600);
                await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle?.close().catch(() => {
                });
            }
        });
    };

    return {
        async load(cwd, sessionId) {
            if (!sessionId) return [];
            const project = await canonicalProject(cwd);
            const lines = await readRecentLines(historyPath);
            const newest: string[] = [];
            const seen = new Set<string>();
            for (let index = lines.length - 1; index >= 0; index--) {
                const entry = parseEntry(lines[index]!);
                if (
                    !entry ||
                    entry.project !== project ||
                    entry.sessionId !== sessionId ||
                    seen.has(entry.input)
                ) {
                    continue;
                }
                seen.add(entry.input);
                newest.push(entry.input);
                if (newest.length >= limit) break;
            }
            return newest.reverse();
        },

        append(cwd, sessionId, input) {
            const operation = appendQueue.then(() =>
                appendEntry(cwd, sessionId, input)
            );
            appendQueue = operation.catch(() => {
            });
            return operation;
        },
    };
}

export const inputHistoryStore = createInputHistoryStore();
