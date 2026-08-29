import {randomUUID} from "node:crypto";
import {dirname} from "node:path";
import {type FileHandle, mkdir, open, readFile, rename, stat, unlink,} from "node:fs/promises";

interface LockOwner {
    version: 1;
    token: string;
    pid: number;
    createdAt: string;
}

export interface FileLockOperations {
    mkdir(path: string): Promise<void>;

    open(path: string, flags: string): Promise<FileHandle>;

    readFile(path: string): Promise<string>;

    rename(from: string, to: string): Promise<void>;

    stat(path: string): Promise<{ mtimeMs: number }>;

    unlink(path: string): Promise<void>;
}

export const nodeFileLockOperations: FileLockOperations = {
    async mkdir(path) {
        await mkdir(path, {recursive: true});
    },
    open,
    async readFile(path) {
        return readFile(path, "utf8");
    },
    rename,
    stat,
    unlink,
};

interface FileLockConfig {
    timeoutMs?: number;
    retryDelayMs?: number;
    staleMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    createToken?: () => string;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
    operations?: FileLockOperations;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_STALE_MS = 30_000;

function isCode(error: unknown, code: string): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === code
    );
}

function parseOwner(value: string): LockOwner | null {
    try {
        const owner = JSON.parse(value) as Partial<LockOwner>;
        if (
            owner.version !== 1 ||
            typeof owner.token !== "string" ||
            typeof owner.pid !== "number" ||
            typeof owner.createdAt !== "string"
        ) {
            return null;
        }
        return owner as LockOwner;
    } catch {
        return null;
    }
}

function defaultIsProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return isCode(error, "EPERM");
    }
}

async function fileExists(
    path: string,
    operations: FileLockOperations
): Promise<boolean> {
    try {
        await operations.stat(path);
        return true;
    } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
    }
}

async function readOwner(
    lockPath: string,
    operations: FileLockOperations
): Promise<LockOwner | null> {
    try {
        return parseOwner(await operations.readFile(lockPath));
    } catch (error) {
        if (isCode(error, "ENOENT")) return null;
        throw error;
    }
}

async function releaseOwnedLock(
    lockPath: string,
    token: string,
    operations: FileLockOperations
): Promise<void> {
    const owner = await readOwner(lockPath, operations);
    if (owner?.token !== token) return;
    try {
        await operations.unlink(lockPath);
    } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
    }
}

async function unlinkIfPresent(
    path: string,
    operations: FileLockOperations
): Promise<void> {
    try {
        await operations.unlink(path);
    } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
    }
}

async function tryRecoverStaleLock(input: {
    lockPath: string;
    recoveryPath: string;
    staleMs: number;
    now: () => number;
    isProcessAlive: (pid: number) => boolean;
    operations: FileLockOperations;
    createToken: () => string;
}): Promise<boolean> {
    let recoveryHandle: FileHandle | undefined;
    try {
        recoveryHandle = await input.operations.open(input.recoveryPath, "wx");
    } catch (error) {
        if (isCode(error, "EEXIST")) return false;
        throw error;
    }

    try {
        await recoveryHandle.writeFile("recovering\n", "utf8");
        await recoveryHandle.close();
        recoveryHandle = undefined;

        let lockStat: { mtimeMs: number };
        try {
            lockStat = await input.operations.stat(input.lockPath);
        } catch (error) {
            if (isCode(error, "ENOENT")) return true;
            throw error;
        }
        if (input.now() - lockStat.mtimeMs < input.staleMs) return false;

        const owner = await readOwner(input.lockPath, input.operations);
        if (owner && input.isProcessAlive(owner.pid)) return false;

        const quarantinePath = `${input.lockPath}.stale.${input.createToken()}`;
        try {
            await input.operations.rename(input.lockPath, quarantinePath);
        } catch (error) {
            if (isCode(error, "ENOENT")) return true;
            throw error;
        }
        try {
            await input.operations.unlink(quarantinePath);
        } catch (error) {
            if (!isCode(error, "ENOENT")) throw error;
        }
        return true;
    } finally {
        if (recoveryHandle) {
            try {
                await recoveryHandle.close();
            } catch {
                // Continue with guard cleanup.
            }
        }
        try {
            await input.operations.unlink(input.recoveryPath);
        } catch (error) {
            if (!isCode(error, "ENOENT")) throw error;
        }
    }
}

/** Serialize a short local-filesystem mutation across Pillar processes. */
export async function withFileLock<T>(
    lockPath: string,
    action: () => Promise<T>
): Promise<T> {
    return defaultFileLock(lockPath, action);
}

export function createFileLock(config: FileLockConfig = {}) {
    const operations = config.operations ?? nodeFileLockOperations;
    const now = config.now ?? Date.now;
    const sleep =
        config.sleep ??
        ((milliseconds: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const createToken = config.createToken ?? randomUUID;
    const isProcessAlive = config.isProcessAlive ?? defaultIsProcessAlive;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const staleMs = config.staleMs ?? DEFAULT_STALE_MS;

    return async function withFileLock<T>(
        lockPath: string,
        action: () => Promise<T>
    ): Promise<T> {
        const token = createToken();
        const pid = config.pid ?? process.pid;
        const recoveryPath = `${lockPath}.recovery`;
        const deadline = now() + timeoutMs;

        await operations.mkdir(dirname(lockPath));

        while (true) {
            if (!(await fileExists(recoveryPath, operations))) {
                let handle: FileHandle | undefined;
                try {
                    handle = await operations.open(lockPath, "wx");
                    const owner: LockOwner = {
                        version: 1,
                        token,
                        pid,
                        createdAt: new Date(now()).toISOString(),
                    };
                    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
                    await handle.sync();
                    await handle.close();
                    handle = undefined;

                    // A stale recovery may have started between the first guard check and
                    // exclusive create. Let it finish before claiming ownership.
                    if (await fileExists(recoveryPath, operations)) {
                        await releaseOwnedLock(lockPath, token, operations);
                    } else {
                        let result: T | undefined;
                        let actionError: unknown;
                        try {
                            result = await action();
                        } catch (error) {
                            actionError = error;
                        }
                        try {
                            await releaseOwnedLock(lockPath, token, operations);
                        } catch (releaseError) {
                            if (actionError === undefined) throw releaseError;
                        }
                        if (actionError !== undefined) throw actionError;
                        return result as T;
                    }
                } catch (error) {
                    if (handle) {
                        try {
                            await handle.close();
                        } catch {
                            // Preserve the acquisition error.
                        }
                        await unlinkIfPresent(lockPath, operations);
                    }
                    if (!isCode(error, "EEXIST")) throw error;
                }
            }

            const recovered = await tryRecoverStaleLock({
                lockPath,
                recoveryPath,
                staleMs,
                now,
                isProcessAlive,
                operations,
                createToken,
            });
            if (recovered) continue;

            if (now() >= deadline) {
                throw new Error(`Timed out waiting for persistence lock: ${lockPath}`);
            }
            await sleep(retryDelayMs);
        }
    };
}

const defaultFileLock = createFileLock();
