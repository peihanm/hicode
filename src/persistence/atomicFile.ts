import {randomUUID} from "node:crypto";
import {basename, dirname, join} from "node:path";
import {type FileHandle, mkdir, open, rename, unlink,} from "node:fs/promises";

interface AtomicFileOperations {
    mkdir(path: string): Promise<void>;

    open(path: string, flags: string, mode?: number): Promise<FileHandle>;

    rename(from: string, to: string): Promise<void>;

    unlink(path: string): Promise<void>;

    syncDirectory(path: string): Promise<void>;
}

export const nodeAtomicFileOperations: AtomicFileOperations = {
    async mkdir(path) {
        await mkdir(path, {recursive: true});
    },
    open,
    rename,
    unlink,
    async syncDirectory(path) {
        const handle = await open(path, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    },
};

interface AtomicFileWriterDependencies {
    operations: AtomicFileOperations;

    createToken(): string;
}

/** Replace a file without exposing partially written contents. */
export function createAtomicFileWriter(
    overrides: Partial<AtomicFileWriterDependencies> = {}
) {
    const operations = overrides.operations ?? nodeAtomicFileOperations;
    const createToken = overrides.createToken ?? randomUUID;

    return async function writeFileAtomically(
        targetPath: string,
        content: string | Uint8Array,
        mode?: number
    ): Promise<void> {
        const directory = dirname(targetPath);
        const token = createToken();
        const temporaryPath = join(
            directory,
            `.${basename(targetPath)}.${process.pid}.${token}.tmp`
        );
        let handle: FileHandle | undefined;
        let renamed = false;

        await operations.mkdir(directory);
        try {
            handle = await operations.open(temporaryPath, "wx", mode);
            await handle.writeFile(content);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await operations.rename(temporaryPath, targetPath);
            renamed = true;

            // Some platforms/filesystems do not support syncing a directory. The
            // replacement already succeeded, so a durability enhancement must not
            // turn it into a reported mutation failure that callers might retry.
            try {
                await operations.syncDirectory(directory);
            } catch {
                // Best effort only.
            }
        } catch (error) {
            if (handle) {
                try {
                    await handle.close();
                } catch {
                    // Preserve the original failure.
                }
            }
            if (!renamed) {
                try {
                    await operations.unlink(temporaryPath);
                } catch {
                    // The file may not have been created, or cleanup may be unavailable.
                }
            }
            throw error;
        }
    };
}

export const writeFileAtomically = createAtomicFileWriter();
